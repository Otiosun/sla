import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface IssuedReadOnlyExpeditionMenu {
  readonly menuId: string;
  readonly outboxMessageId: string;
  readonly text: string;
  readonly ballItemIds: Readonly<Record<string, string>>;
  readonly replayed: boolean;
}

export interface IssueReadOnlyExpeditionMenuInput {
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: string;
  readonly expectedEncounterRevision: bigint;
  readonly destinationRef: string;
  readonly correlationId: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const BALL_CHOICES = [
  { choice: "2", displayName: "Poké Ball" },
  { choice: "3", displayName: "Great Ball" },
  { choice: "4", displayName: "Ultra Ball" },
] as const;

/**
 * STAGING ONLY. The exact text, frozen Ball IDs, outbound message and its
 * deterministic Baileys reply reference are committed atomically. The worker
 * may send ONLY after COMMIT. READ_ONLY is mandatory until capture/PvE is wired.
 *
 * Neither a caller-supplied Ball nor a client-selected menu ID is trusted.
 * An existing outcome has exactly one immutable menu; repeat requests return
 * the same text/Outbox without issuing another message.
 */
export class PostgresExpeditionReadOnlyMenuIssuer {
  constructor(private readonly pool: Pool) {}

  async issue(input: IssueReadOnlyExpeditionMenuInput): Promise<Result<IssuedReadOnlyExpeditionMenu>> {
    if (
      !UUID.test(input.playerId) ||
      !UUID.test(input.outcomeId) ||
      !UUID.test(input.encounterId) ||
      !UUID.test(input.correlationId) ||
      input.expectedEncounterRevision < 0n ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(input.destinationRef)
    ) {
      return err(appError("FLOW_BLOCKED", "Cannot issue an encounter menu to an unverified player"));
    }

    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      // Serialize issuing/replaying a menu for a trainer without attempting
      // to lock the joined OUTBOX row from the transport's own worker.
      const owner = await client.query(
        `SELECT 1 FROM players player
         JOIN onboarding_states onboard ON onboard.player_id = player.id
         WHERE player.id = $1 AND player.status = 'ACTIVE'
           AND onboard.state = 'COMPLETE' FOR UPDATE OF player`,
        [input.playerId],
      );
      if (owner.rowCount !== 1) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return err(appError("PLAYER_INELIGIBLE", "Trainer is not active and registered"));
      }
      const eligible = await client.query<{ release_id: string }>(
        `SELECT encounter.content_release_id::text AS release_id
         FROM solo_expedition_search_outcomes outcome
         JOIN solo_expeditions expedition
           ON expedition.id = outcome.expedition_id
          AND expedition.player_id = outcome.player_id
          AND expedition.phase = 'ACTIVE'
         JOIN encounters encounter
           ON encounter.id = outcome.encounter_id
          AND encounter.player_id = outcome.player_id
          AND encounter.area_id = expedition.area_id
          AND encounter.status = 'ENGAGED'
          AND encounter.revision = $4
          AND NOT EXISTS (
            SELECT 1 FROM battles battle
            WHERE battle.encounter_id = encounter.id AND battle.status = 'ACTIVE'
          )
         JOIN content_release_pointers pointer ON pointer.pointer_key = 'ACTIVE'
         JOIN content_releases release
           ON release.id = pointer.content_release_id
          AND release.status = 'PUBLISHED'
          AND release.id = encounter.content_release_id
         WHERE outcome.id = $1
           AND outcome.player_id = $2
           AND outcome.encounter_id = $3
           AND outcome.kind IN ('DIRECT','INCIDENTAL')
           AND EXISTS (
             SELECT 1 FROM outbox_messages source
             WHERE source.channel = 'whatsapp'
               AND source.destination_ref = $5
               AND source.message_type = 'TEXT'
               AND source.status = 'SENT'
               AND source.sent_at IS NOT NULL
               AND source.payload->'expeditionSearch'->>'playerId' = $2::text
               AND source.payload->'expeditionSearch'->>'outcomeId' = $1::text
               AND source.payload->'expeditionSearch'->>'encounterId' = $3::text
           )
         LIMIT 2`,
        [
          input.outcomeId,
          input.playerId,
          input.encounterId,
          input.expectedEncounterRevision.toString(),
          input.destinationRef,
        ],
      );
      const releaseId = eligible.rows[0]?.release_id;
      if (eligible.rows.length !== 1 || releaseId === undefined) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return err(appError("FLOW_BLOCKED", "Encounter is not a published, presented active encounter"));
      }

      const existing = await client.query<{
        id: string;
        text: string;
        ball_item_ids: Record<string, string>;
        outbox_id: string;
        destination_ref: string;
      }>(
        `SELECT menu.id::text AS id,
                menu.panel->>'text' AS text,
                menu.ball_item_ids,
                outbox.id::text AS outbox_id,
                outbox.destination_ref
         FROM solo_incidental_menu_snapshots menu
         JOIN solo_incidental_menu_deliveries delivery
           ON delivery.menu_id = menu.id AND delivery.player_id = menu.player_id
         JOIN outbox_messages outbox
           ON outbox.channel = 'whatsapp'
          AND upper(replace(outbox.id::text,'-','')) = upper(delivery.external_message_id)
          AND outbox.destination_ref = delivery.chat_ref
          AND outbox.payload->'expeditionMenu'->>'menuId' = menu.id::text
         WHERE menu.outcome_id = $1
           AND menu.player_id = $2
           AND menu.encounter_id = $3
           AND menu.encounter_revision = $4
           AND delivery.provider = 'baileys'
         LIMIT 2`,
        [input.outcomeId, input.playerId, input.encounterId, input.expectedEncounterRevision.toString()],
      );
      const previously = existing.rows[0];
      if (existing.rows.length > 0) {
        if (
          existing.rows.length !== 1 ||
          previously === undefined ||
          previously.destination_ref !== input.destinationRef ||
          typeof previously.text !== "string" ||
          previously.ball_item_ids === null ||
          typeof previously.ball_item_ids !== "object"
        ) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return err(appError("FLOW_BLOCKED", "Existing issued menu cannot be safely replayed"));
        }
        await client.query("COMMIT");
        inTransaction = false;
        return ok({
          menuId: previously.id,
          outboxMessageId: previously.outbox_id,
          text: previously.text,
          ballItemIds: previously.ball_item_ids,
          replayed: true,
        });
      }
      // A dangling snapshot must never be replaced if a previous transaction
      // somehow persisted a menu without a usable Outbox/delivery link.
      const orphan = await client.query(
        "SELECT 1 FROM solo_incidental_menu_snapshots WHERE outcome_id = $1",
        [input.outcomeId],
      );
      if ((orphan.rowCount ?? 0) !== 0) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return err(appError("FLOW_BLOCKED", "An issued menu is incomplete and needs operator recovery"));
      }

      // The list is pinned from true positive inventory balances and the
      // active content release. No advertised Ball is fabricated.
      const inventory = await client.query<{ item_id: string; display_name: string; quantity: string }>(
        `SELECT balance.item_id::text AS item_id,
                revision.display_name,
                balance.quantity::text
         FROM inventory_balances balance
         JOIN item_revisions revision
           ON revision.item_id = balance.item_id
          AND revision.content_release_id = $2
          AND revision.active = TRUE
         WHERE balance.player_id = $1
           AND balance.quantity > 0
           AND revision.item_kind = 'BALL'
           AND revision.effect_key = 'catch-modifier'
           AND revision.display_name = ANY($3::text[])
         ORDER BY revision.display_name, balance.item_id`,
        [input.playerId, releaseId, BALL_CHOICES.map((ball) => ball.displayName)],
      );
      const byName = new Map<string, { itemId: string; quantity: string }>();
      for (const row of inventory.rows) {
        if (
          byName.has(row.display_name) ||
          !UUID.test(row.item_id) ||
          !/^[1-9][0-9]*$/u.test(row.quantity)
        ) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return err(appError("FLOW_BLOCKED", "Published Ball inventory is ambiguous"));
        }
        byName.set(row.display_name, { itemId: row.item_id, quantity: row.quantity });
      }
      const lines = [
        "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*",
        "> _Prévia de menu vinculada ao encontro._",
        "",
        "◇ *BOLSAS DISPONÍVEIS*",
      ];
      const ballItemIds: Record<string, string> = {};
      for (const ball of BALL_CHOICES) {
        const entry = byName.get(ball.displayName);
        if (entry !== undefined) {
          lines.push(`${ball.choice}. ${ball.displayName} ×${entry.quantity} (somente prévia)`);
          ballItemIds[ball.choice] = entry.itemId;
        }
      }
      if (byName.size === 0) lines.push("› _Nenhuma Poké Ball elegível no inventário._");
      lines.push(
        "",
        "› _Nenhuma escolha executa captura, batalha ou consumo de item nesta prévia._",
        "› _Este menu de homologação não está habilitado no jogo ativo._",
      );
      const text = lines.join("\n");
      const menuId = randomUUID();
      const outboxMessageId = randomUUID();
      const immutableIdempotencyKey = `exploration-issued-menu:${input.outcomeId}`;
      await client.query(
        `INSERT INTO solo_incidental_menu_snapshots
         (id,player_id,outcome_id,encounter_id,encounter_revision,panel,ball_item_ids)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [
          menuId,
          input.playerId,
          input.outcomeId,
          input.encounterId,
          input.expectedEncounterRevision.toString(),
          JSON.stringify({ mode: "READ_ONLY", text }),
          JSON.stringify(ballItemIds),
        ],
      );
      await client.query(
        `INSERT INTO outbox_messages
         (id,channel,destination_ref,message_type,payload,idempotency_key,
          status,attempts,next_attempt_at,correlation_id)
         VALUES($1,'whatsapp',$2,'TEXT',$3::jsonb,$4,'PENDING',0,now(),$5)`,
        [
          outboxMessageId,
          input.destinationRef,
          JSON.stringify({
            text,
            expeditionSearch: {
              playerId: input.playerId,
              outcomeId: input.outcomeId,
              encounterId: input.encounterId,
            },
            expeditionMenu: { menuId, mode: "READ_ONLY" },
          }),
          immutableIdempotencyKey,
          input.correlationId,
        ],
      );
      // The delivery binding is reserved before sending, but verification
      // ONLY authorizes a quote after the Outbox becomes SENT.
      await client.query(
        `INSERT INTO solo_incidental_menu_deliveries
         (id,menu_id,player_id,provider,chat_ref,external_message_id)
         VALUES($1,$2,$3,'baileys',$4,$5)`,
        [
          randomUUID(),
          menuId,
          input.playerId,
          input.destinationRef,
          outboxMessageId.replaceAll("-", "").toUpperCase(),
        ],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return ok({ menuId, outboxMessageId, text, ballItemIds, replayed: false });
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve original error and ensure no success is reported.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
