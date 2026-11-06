import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { BattleSeedReader } from "../../modules/battle/ports.js";
import { PveBattleStartService } from "../../modules/battle/pve-battle-start.js";
import { BattleService } from "../../modules/battle/service.js";
import type { EncounterSeedProvider } from "../../modules/encounter/ports.js";
import { EncounterService } from "../../modules/encounter/service.js";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { type AppError, appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { battleRepositoryWithinTransaction } from "../battle/postgres-battle-repository.js";
import type { Clock } from "../clock/index.js";
import { withTransaction } from "../db/transaction.js";
import { encounterRepositoryWithinTransaction } from "../encounter/postgres-encounter-repository.js";
import { readOfflineExpeditionBattleEligibility } from "./postgres-expedition-battle-eligibility.js";

interface ReceiptRow {
  readonly battle_id: string;
  readonly fingerprint: string;
  readonly menu_id: string;
  readonly outcome_id: string;
  readonly encounter_id: string;
  readonly encounter_revision: string;
  readonly inbox_message_id: string;
}
class RejectBattle extends Error {
  constructor(public readonly issue: AppError) {
    super(issue.message);
  }
}
export interface StartOfflineExpeditionBattleInput {
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: string;
  readonly expectedEncounterRevision: bigint;
  readonly menuId: string;
  readonly inboxMessageId: string;
  readonly idempotencyKey: string;
  readonly messageFingerprint: string;
  readonly senderRef: string;
}

/**
 * Isolated OFFLINE proof only. Canonical Encounter.startBattle, BattleService
 * initialization and immutable Inbox/issued-menu receipt are ONE transaction.
 * On initialization failure, throw to roll back Encounter/Battle together:
 * the compensating rollback port is intentionally not used here.
 */
export class PostgresExpeditionOfflineBattleStart {
  constructor(
    private readonly pool: Pool,
    private readonly seedProvider: EncounterSeedProvider,
    private readonly seedReader: BattleSeedReader,
    private readonly clock: Clock,
    private readonly feature: FeatureAvailability,
  ) {}

  async execute(
    input: StartOfflineExpeditionBattleInput,
  ): Promise<Result<{ readonly battleId: string; readonly replayed: boolean }>> {
    if (!expeditionOperationAllowed(input.playerId)) {
      return err(appError("FLOW_BLOCKED", "PvE receipt requires offline staging"));
    }
    if (
      !/^[a-f0-9-]{36}$/iu.test(input.inboxMessageId) ||
      !/^[a-f0-9-]{36}$/iu.test(input.menuId) ||
      !/^[a-f0-9-]{36}$/iu.test(input.encounterId) ||
      !/^[a-f0-9-]{36}$/iu.test(input.outcomeId) ||
      !/^[a-f0-9]{64}$/u.test(input.messageFingerprint) ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(input.senderRef) ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 200 ||
      input.expectedEncounterRevision < 0n
    ) {
      return err(appError("FLOW_BLOCKED", "Invalid canonical battle claim identity"));
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.playerId,
          input.outcomeId,
          input.encounterId,
          input.expectedEncounterRevision.toString(),
          input.menuId,
          input.inboxMessageId,
          input.messageFingerprint,
          input.senderRef,
        ]),
      )
      .digest("hex");

    try {
      return await withTransaction(this.pool, async (client) => {
        const owner = await client.query(
          "SELECT 1 FROM players WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
          [input.playerId],
        );
        if (owner.rowCount !== 1)
          return err(appError("PLAYER_INELIGIBLE", "Trainer is not active"));
        const old = await client.query<ReceiptRow>(
          "SELECT battle_id::text, fingerprint, menu_id::text, outcome_id::text, encounter_id::text, encounter_revision::text, inbox_message_id::text FROM solo_expedition_battle_receipts WHERE player_id=$1 AND idempotency_key=$2",
          [input.playerId, input.idempotencyKey],
        );
        if (old.rows.length > 0) {
          const receipt = old.rows[0];
          if (
            old.rows.length !== 1 ||
            receipt === undefined ||
            receipt.fingerprint !== fingerprint ||
            receipt.inbox_message_id !== input.inboxMessageId ||
            receipt.menu_id !== input.menuId ||
            receipt.outcome_id !== input.outcomeId ||
            receipt.encounter_id !== input.encounterId ||
            receipt.encounter_revision !== input.expectedEncounterRevision.toString()
          ) {
            return err(appError("IDEMPOTENCY_KEY_INVALID", "Battle receipt identity mismatch"));
          }
          return ok({ battleId: receipt.battle_id, replayed: true });
        }
        const verified = await client.query<{ content_release_id: string }>(
          `SELECT encounter.content_release_id::text
           FROM inbox_messages inbox
           JOIN player_identities identity
             ON identity.provider=inbox.provider
            AND identity.external_id=$4
            AND identity.player_id=$1 AND identity.status='ACTIVE'
           JOIN solo_incidental_menu_deliveries delivery
             ON delivery.provider='baileys' AND delivery.player_id=$1
            AND delivery.chat_ref=$4
            AND upper(delivery.external_message_id)=
                upper(inbox.normalized_payload->>'replyToExternalMessageId')
           JOIN solo_incidental_menu_snapshots menu
             ON menu.id=delivery.menu_id AND menu.player_id=$1
            AND menu.id=$5
            AND menu.outcome_id=$6 AND menu.encounter_id=$7
            AND menu.encounter_revision=$8::bigint
            AND menu.panel->>'mode'='ACTIONABLE'
            AND menu.panel->'actions' ? 'BATTLE'
           JOIN solo_expedition_search_outcomes outcome
             ON outcome.id=menu.outcome_id AND outcome.player_id=$1
            AND outcome.encounter_id=menu.encounter_id
            AND outcome.kind IN ('DIRECT','INCIDENTAL')
           JOIN solo_expeditions expedition
             ON expedition.id=outcome.expedition_id AND expedition.player_id=$1
            AND expedition.phase='ACTIVE'
           JOIN encounters encounter
             ON encounter.id=menu.encounter_id
            AND encounter.player_id=$1
            AND encounter.area_id=expedition.area_id
            AND encounter.status='ENGAGED'
          AND (encounter.expires_at IS NULL OR encounter.expires_at>clock_timestamp())
            AND encounter.revision=menu.encounter_revision
           JOIN content_release_pointers pointer ON pointer.pointer_key='ACTIVE'
           JOIN content_releases release
             ON release.id=pointer.content_release_id
            AND release.id=encounter.content_release_id
            AND release.status='PUBLISHED'
           JOIN outbox_messages outbound
             ON outbound.channel='whatsapp' AND outbound.message_type='TEXT'
            AND outbound.status='SENT' AND outbound.sent_at IS NOT NULL
            AND outbound.destination_ref=$4
            AND upper(replace(outbound.id::text,'-',''))=upper(delivery.external_message_id)
            AND outbound.payload->>'text'=menu.panel->>'text'
            AND outbound.payload->'expeditionMenu'->>'menuId'=menu.id::text
            AND outbound.payload->'expeditionMenu'->>'mode'='ACTIONABLE'
            AND outbound.payload->'expeditionMenu'->'actions'=menu.panel->'actions'
            AND outbound.payload->'expeditionMenu'->'ballItemIds'=menu.ball_item_ids
            AND outbound.payload->'expeditionSearch'->>'playerId'=$1::text
            AND outbound.payload->'expeditionSearch'->>'outcomeId'=$6::text
            AND outbound.payload->'expeditionSearch'->>'encounterId'=$7::text
           WHERE inbox.id=$2 AND inbox.provider='baileys'
             AND inbox.status='PROCESSING' AND inbox.payload_hash=$3
             AND inbox.normalized_payload->>'senderRef'=$4
             AND inbox.normalized_payload->>'chatRef'=$4
             AND trim(inbox.normalized_payload->>'text')='1'
             AND NOT EXISTS (
               SELECT 1 FROM battles prior
               WHERE prior.encounter_id=encounter.id
                 AND prior.status IN ('CREATED','ACTIVE')
             )
           LIMIT 2`,
          [
            input.playerId,
            input.inboxMessageId,
            input.messageFingerprint,
            input.senderRef,
            input.menuId,
            input.outcomeId,
            input.encounterId,
            input.expectedEncounterRevision.toString(),
          ],
        );
        const releaseId = verified.rows[0]?.content_release_id;
        if (verified.rows.length !== 1 || releaseId === undefined) {
          return err(appError("FLOW_BLOCKED", "No exact SENT PvE consent for this Inbox"));
        }
        if (
          !(await readOfflineExpeditionBattleEligibility(client, {
            playerId: input.playerId,
            encounterId: input.encounterId,
            contentReleaseId: releaseId,
          }))
        ) {
          return err(appError("FLOW_BLOCKED", "Frozen party is no longer eligible for battle"));
        }
        const pve = new PveBattleStartService(
          new EncounterService(
            encounterRepositoryWithinTransaction(client),
            this.seedProvider,
            this.clock,
            this.feature,
          ),
          new BattleService(battleRepositoryWithinTransaction(client), this.seedReader),
        );
        const started = await pve.startCanonical({
          playerId: input.playerId,
          encounterId: input.encounterId as never,
          expectedRevision: input.expectedEncounterRevision,
          status: "ENGAGED",
        });
        if (!started.ok) {
          throw new RejectBattle(
            appError("FLOW_BLOCKED", "Canonical PvE start failed", {
              battleError: started.error.code,
            }),
          );
        }
        const battleId = started.value.start.battleId;
        if (started.value.initialization.state.status !== "ACTIVE") {
          throw new RejectBattle(appError("FLOW_BLOCKED", "Canonical battle was not initialized"));
        }
        await client.query(
          `INSERT INTO solo_expedition_battle_receipts(
             player_id,idempotency_key,inbox_message_id,menu_id,
             outcome_id,encounter_id,encounter_revision,battle_id,fingerprint
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.playerId,
            input.idempotencyKey,
            input.inboxMessageId,
            input.menuId,
            input.outcomeId,
            input.encounterId,
            input.expectedEncounterRevision.toString(),
            battleId,
            fingerprint,
          ],
        );
        return ok({ battleId, replayed: false });
      });
    } catch (error) {
      if (error instanceof RejectBattle) return err(error.issue);
      throw error;
    }
  }
}
