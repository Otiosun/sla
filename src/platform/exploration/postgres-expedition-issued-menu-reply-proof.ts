import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface VerifiedExpeditionIssuedMenu {
  readonly menuId: string;
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: string;
  readonly encounterRevision: bigint;
  /** Exact authorized item IDs issued with this immutable menu, never live-index remapped. */
  readonly ballItemIds: Readonly<Record<string, string>>;
  /** Omitted for any legacy, malformed or READ_ONLY menu. */
  readonly actionable?: true;
  readonly captureEnabled?: boolean;
  readonly battleEnabled?: boolean;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

/**
 * STAGING ONLY. Read the *server-issued* immutable menu snapshot through its
 * provider message binding. No menu implies NO ACTION, even if the Encounter
 * is still ENGAGED. This proof does not grant a capture or start a battle.
 */
export class PostgresExpeditionIssuedMenuReplyProof {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async resolve(input: {
    readonly provider: string;
    readonly playerId: PlayerId;
    readonly senderRef: string;
    readonly chatRef: string;
    readonly replyToExternalMessageId: string | null;
  }): Promise<Result<VerifiedExpeditionIssuedMenu>> {
    const quoted = input.replyToExternalMessageId;
    if (
      input.provider !== "baileys" ||
      input.chatRef !== input.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(input.senderRef) ||
      !/^[a-f0-9]{32}$/iu.test(quoted ?? "") ||
      !UUID.test(input.playerId)
    ) {
      return err(appError("FLOW_BLOCKED", "Issued private encounter menu is required"));
    }

    const found = await this.pool.query<{
      menu_id: string;
      player_id: string;
      outcome_id: string;
      encounter_id: string;
      encounter_revision: string;
      ball_item_ids: unknown;
      menu_mode: string | null;
      capture_enabled: boolean;
      battle_enabled: boolean;
    }>(
      `SELECT menu.id::text AS menu_id,
              menu.player_id::text AS player_id,
              menu.outcome_id::text AS outcome_id,
              menu.encounter_id::text AS encounter_id,
              menu.encounter_revision::text AS encounter_revision,
              menu.ball_item_ids,
              menu.panel->>'mode' AS menu_mode,
              CASE WHEN jsonb_typeof(menu.panel->'actions') = 'array'
                THEN menu.panel->'actions' ? 'CAPTURE' ELSE FALSE END AS capture_enabled,
              CASE WHEN jsonb_typeof(menu.panel->'actions') = 'array'
                THEN menu.panel->'actions' ? 'BATTLE' ELSE FALSE END AS battle_enabled
       FROM solo_incidental_menu_deliveries delivery
       JOIN solo_incidental_menu_snapshots menu
         ON menu.id = delivery.menu_id
        AND menu.player_id = delivery.player_id
       JOIN solo_expedition_search_outcomes outcome
         ON outcome.id = menu.outcome_id
        AND outcome.player_id = menu.player_id
        AND outcome.encounter_id = menu.encounter_id
        AND outcome.kind IN ('DIRECT', 'INCIDENTAL')
       JOIN solo_expeditions expedition
         ON expedition.id = outcome.expedition_id
        AND expedition.player_id = menu.player_id
        AND expedition.phase = 'ACTIVE'
       JOIN encounters encounter
         ON encounter.id = menu.encounter_id
        AND encounter.player_id = menu.player_id
        AND encounter.area_id = expedition.area_id
        AND encounter.revision = menu.encounter_revision
        AND encounter.status = 'ENGAGED'
       JOIN content_release_pointers pointer ON pointer.pointer_key = 'ACTIVE'
       JOIN content_releases release
         ON release.id = pointer.content_release_id
        AND release.status = 'PUBLISHED'
        AND encounter.content_release_id = release.id
       JOIN outbox_messages outbox
         ON outbox.channel = 'whatsapp'
        AND outbox.message_type = 'TEXT'
        AND outbox.status = 'SENT'
        AND outbox.sent_at IS NOT NULL
        AND outbox.destination_ref = delivery.chat_ref
        AND upper(replace(outbox.id::text, '-', '')) = upper(delivery.external_message_id)
        AND outbox.payload->'expeditionSearch'->>'playerId' = menu.player_id::text
        AND outbox.payload->'expeditionSearch'->>'outcomeId' = menu.outcome_id::text
        AND outbox.payload->'expeditionSearch'->>'encounterId' = menu.encounter_id::text
       WHERE delivery.provider = $1
         AND delivery.chat_ref = $2
         AND upper(delivery.external_message_id) = upper($3)
         AND delivery.player_id = $4
         AND menu.player_id = $4
         -- A screenshot or old read-only Outbox may never be upgraded into
         -- an ACTIONABLE menu by changing only the snapshot's JSON metadata.
         AND (
           menu.panel->>'mode' IS DISTINCT FROM 'ACTIONABLE'
           OR (
             outbox.payload->'expeditionMenu'->>'menuId' = menu.id::text
             AND outbox.payload->'expeditionMenu'->>'mode' = 'ACTIONABLE'
           )
         )
         -- Supersede an old menu only once a different menu for the SAME
         -- Encounter was actually delivered; pending previews cannot revoke
         -- working choices. Tied issue timestamps fail closed.
         AND NOT EXISTS (
           SELECT 1 FROM solo_incidental_menu_snapshots newer
           JOIN solo_incidental_menu_deliveries newer_delivery
             ON newer_delivery.menu_id = newer.id
            AND newer_delivery.player_id = menu.player_id
           JOIN outbox_messages newer_outbox
             ON newer_outbox.channel = 'whatsapp'
            AND newer_outbox.message_type = 'TEXT'
            AND newer_outbox.status = 'SENT'
            AND newer_outbox.sent_at IS NOT NULL
            AND newer_outbox.destination_ref = newer_delivery.chat_ref
            AND upper(replace(newer_outbox.id::text, '-', '')) = upper(newer_delivery.external_message_id)
           WHERE newer.player_id = menu.player_id
             AND newer.encounter_id = menu.encounter_id
             AND newer.id <> menu.id
             AND newer.created_at >= menu.created_at
         )
       LIMIT 2`,
      [input.provider, input.senderRef, quoted, input.playerId],
    );

    const row = found.rows[0];
    if (
      found.rows.length !== 1 ||
      row === undefined ||
      row.player_id !== input.playerId ||
      !UUID.test(row.menu_id) ||
      !UUID.test(row.outcome_id) ||
      !UUID.test(row.encounter_id) ||
      !/^[0-9]+$/u.test(row.encounter_revision) ||
      typeof row.ball_item_ids !== "object" ||
      row.ball_item_ids === null ||
      Array.isArray(row.ball_item_ids)
    ) {
      return err(appError("FLOW_BLOCKED", "No current issued menu for this quoted message"));
    }

    const entries = Object.entries(row.ball_item_ids);
    if (
      entries.length > 3 ||
      entries.some(
        ([choice, itemId]) =>
          !["2", "3", "4"].includes(choice) || typeof itemId !== "string" || !UUID.test(itemId),
      ) ||
      new Set(entries.map(([, itemId]) => itemId)).size !== entries.length
    ) {
      return err(appError("FLOW_BLOCKED", "Issued menu has invalid immutable Ball choices"));
    }

    return ok({
      menuId: row.menu_id,
      playerId: input.playerId,
      outcomeId: row.outcome_id,
      encounterId: row.encounter_id,
      encounterRevision: BigInt(row.encounter_revision),
      ballItemIds: Object.fromEntries(entries) as Readonly<Record<string, string>>,
      ...(row.menu_mode === "ACTIONABLE"
        ? {
            actionable: true as const,
            captureEnabled: row.capture_enabled === true,
            battleEnabled: row.battle_enabled === true,
          }
        : {}),
    });
  }
}
