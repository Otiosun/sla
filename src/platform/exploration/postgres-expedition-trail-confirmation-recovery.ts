import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { StoredSearchOutcome } from "./expedition-search-outcome-effect.js";
import type { VerifiedExpeditionSearchEncounterPreview } from "./postgres-expedition-search-encounter-preview.js";

interface RecoveryRow {
  readonly player_id: string;
  readonly expedition_id: string;
  readonly follow_revision: string;
  readonly result_revision: string;
  readonly source_outcome_id: string;
  readonly result_id: string;
  readonly followed_outcome_id: string;
  readonly encounter_id: string;
  readonly species_name: string;
  readonly encounter_level: number;
  readonly shiny: boolean;
  readonly elapsed_minutes: string;
  readonly consumed_slot: boolean;
  readonly fingerprint: string;
}

export interface RecoveredTrailConfirmation {
  readonly outcome: StoredSearchOutcome;
  readonly encounterPreview: VerifiedExpeditionSearchEncounterPreview;
  readonly elapsedMinutes: number;
  readonly consumedWeeklySlot: false;
}

/** Exact original, trusted PROCESSING Inbox and immutable follow receipt
 * reconstruct an anchored encounter result. No reroll, extra 15 minutes,
 * new encounter or second Outbox action is created here. */
export class PostgresExpeditionTrailConfirmationRecovery {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<Result<RecoveredTrailConfirmation | null>> {
    const message = input.context.message;
    if (
      process.env.APP_ENV !== "test" ||
      process.env.NODE_ENV !== "test" ||
      process.env.WHATSAPP_ENABLED !== "false" ||
      message.provider !== "baileys" ||
      !/^\/explorar\s+(?:seguir(?:\s+rastros)?|rastros)$/iu.test(message.text?.trim() ?? "")
    ) {
      return ok(null);
    }
    const rows = await this.pool.query<RecoveryRow>(
      `SELECT follow.player_id::text,follow.expedition_id::text,
              follow.follow_revision::text,
              receipt.result->'expedition'->>'revision' AS result_revision,
              follow.source_outcome_id::text, follow.id::text AS result_id,
              follow.followed_outcome_id::text,follow.encounter_id::text,
              follow.species_name, follow.encounter_level,follow.shiny,
              receipt.result->'expedition'->>'elapsedMinutes' AS elapsed_minutes,
              (receipt.result->>'consumedWeeklySlot')::boolean AS consumed_slot,
              receipt.fingerprint
       FROM inbox_messages inbox
       JOIN player_identities identity
         ON identity.provider=inbox.provider AND identity.external_id=$5
        AND identity.player_id=$2 AND identity.status='ACTIVE'
       JOIN solo_expedition_receipts receipt
         ON receipt.player_id=identity.player_id
        AND receipt.idempotency_key=$3
        AND receipt.operation='ACTION_FOLLOW_TRAIL'
       JOIN solo_expedition_trail_follows follow
         ON follow.id::text=receipt.result->>'effectRef'
        AND follow.expedition_id=receipt.expedition_id
        AND follow.player_id=receipt.player_id
       JOIN solo_expedition_search_outcomes source
         ON source.id=follow.source_outcome_id
        AND source.kind='TRAIL' AND source.encounter_id IS NULL
        AND source.expedition_revision+1=follow.follow_revision
       JOIN solo_expedition_search_outcomes outcome
         ON outcome.id=follow.followed_outcome_id
        AND outcome.encounter_id=follow.encounter_id
        AND outcome.kind='DIRECT'
        AND outcome.expedition_revision=follow.follow_revision
       JOIN encounters encounter
         ON encounter.id=follow.encounter_id
        AND encounter.player_id=follow.player_id
        AND encounter.content_release_id=follow.content_release_id
       JOIN content_releases release
         ON release.id=follow.content_release_id
        AND release.status IN ('PUBLISHED','ARCHIVED')
       WHERE inbox.id=$1
         AND inbox.status='PROCESSING' AND inbox.provider='baileys'
         AND inbox.external_message_id=$6 AND inbox.payload_hash=$4
         AND inbox.normalized_payload->>'senderRef'=$5
         AND inbox.normalized_payload->>'chatRef'=$7
         AND lower(trim(inbox.normalized_payload->>'text'))=lower($8)
       LIMIT 2`,
      [
        input.context.inboxMessageId,
        input.playerId,
        input.context.idempotencyKey,
        incomingMessageFingerprint(message),
        message.senderRef,
        message.externalMessageId,
        message.chatRef,
        message.text?.trim(),
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) return ok(null);
    if (
      rows.rows.length !== 1 ||
      !/^[1-9][0-9]*$/u.test(row.follow_revision) ||
      !/^[1-9][0-9]*$/u.test(row.result_revision)
    ) {
      return err(appError("FLOW_BLOCKED", "Ambiguous or invalid trail recovery receipt"));
    }
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "ACTION_FOLLOW_TRAIL",
          row.expedition_id,
          row.follow_revision,
          15,
          row.source_outcome_id,
        ]),
      )
      .digest("hex");
    const elapsedMinutes = Number(row.elapsed_minutes);
    if (
      row.player_id !== input.playerId ||
      row.fingerprint !== expected ||
      BigInt(row.result_revision) !== BigInt(row.follow_revision) + 1n ||
      !Number.isSafeInteger(elapsedMinutes) ||
      elapsedMinutes < 45 ||
      elapsedMinutes > 720 ||
      row.consumed_slot !== false ||
      !Number.isSafeInteger(row.encounter_level) ||
      row.encounter_level < 1 ||
      row.encounter_level > 100 ||
      typeof row.shiny !== "boolean" ||
      typeof row.species_name !== "string" ||
      row.species_name.length < 1 ||
      row.species_name.length > 70
    ) {
      return err(appError("FLOW_BLOCKED", "Committed trail evidence is inconsistent"));
    }
    return ok({
      outcome: {
        outcomeId: row.followed_outcome_id,
        playerId: input.playerId,
        expeditionId: row.expedition_id,
        expeditionRevision: BigInt(row.follow_revision),
        kind: "DIRECT",
        encounterId: row.encounter_id,
      },
      encounterPreview: {
        speciesName: row.species_name,
        level: row.encounter_level,
        shiny: row.shiny,
      },
      elapsedMinutes,
      consumedWeeklySlot: false,
    });
  }
}
