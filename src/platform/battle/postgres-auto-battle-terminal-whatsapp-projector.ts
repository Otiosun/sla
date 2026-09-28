import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

interface AutoTerminalRow {
  readonly battle_id: string;
  readonly status: "WON" | "LOST" | "DRAW" | "FLED";
  readonly player_id: string;
  readonly chat_ref: string;
  readonly external_id: string;
}

export interface AutoBattleTerminalProjectionResult {
  readonly claimed: number;
  readonly projected: number;
}

function mentionTag(ref: string): string {
  const local = ref.split("@", 1)[0] ?? ref;
  return `@${local.replace(/:\d+$/u, "")}`;
}

function terminalText(row: AutoTerminalRow): string {
  const result =
    row.status === "WON"
      ? "🏆 Vitória."
      : row.status === "LOST"
        ? "❌ Derrota."
        : row.status === "DRAW"
          ? "➖ Empate."
          : "💨 A batalha terminou em fuga.";
  return ["🤖 *BATALHA AUTOMÁTICA · FIM*", "", mentionTag(row.external_id), result].join("\n");
}

export class PostgresAutoBattleTerminalWhatsAppProjector {
  public constructor(private readonly pool: Pool) {}

  public async runOnce(limit: number): Promise<AutoBattleTerminalProjectionResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("AUTO battle terminal projection limit must be a positive safe integer");
    }

    const result = await this.pool.query<AutoTerminalRow>(
      `SELECT battle.id::text AS battle_id,
              battle.status,
              encounter.player_id::text AS player_id,
              origin.chat_ref,
              identity.external_id
       FROM battles battle
       JOIN encounters encounter ON encounter.id = battle.encounter_id
       JOIN player_identities identity
         ON identity.player_id = encounter.player_id
        AND identity.provider = 'baileys'
        AND identity.status = 'ACTIVE'
       JOIN LATERAL (
         SELECT inbox.normalized_payload->>'chatRef' AS chat_ref
         FROM inbox_messages inbox
         JOIN community_groups community
           ON community.chat_ref = inbox.normalized_payload->>'chatRef'
          AND community.status = 'ACTIVE'
         WHERE inbox.status = 'PROCESSED'
           AND inbox.result_ref_type = 'BATTLE'
           AND inbox.result_ref_id = battle.id
           AND inbox.normalized_payload->>'provider' = 'baileys'
         ORDER BY inbox.processed_at DESC NULLS LAST,
                  inbox.received_at DESC,
                  inbox.id DESC
         LIMIT 1
       ) origin ON TRUE
       WHERE battle.battle_type = 'WILD'
         AND battle.status IN ('WON', 'LOST', 'DRAW', 'FLED')
         AND EXISTS (
           SELECT 1
           FROM battle_participant_controllers controller
           WHERE controller.battle_id = battle.id
             AND controller.kind = 'AUTO'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM battle_participant_controllers controller
           WHERE controller.battle_id = battle.id
             AND controller.kind <> 'AUTO'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM outbox_messages outbox
           WHERE outbox.idempotency_key = 'battle.auto-terminal-whatsapp:' || battle.id::text
         )
       ORDER BY battle.updated_at, battle.id
       LIMIT $1`,
      [limit],
    );

    let projected = 0;
    for (const row of result.rows) {
      const inserted = await this.pool.query(
        `INSERT INTO outbox_messages(
           id, channel, destination_ref, message_type, payload, idempotency_key,
           status, attempts, next_attempt_at, correlation_id, causation_id
         ) VALUES (
           $1, 'whatsapp', $2, 'TEXT', $3::jsonb, $4,
           'PENDING', 0, now(), $5, NULL
         )
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          row.chat_ref,
          JSON.stringify({
            text: terminalText(row),
            mentions: [row.external_id],
            autoBattleTerminal: {
              battleId: row.battle_id,
              playerId: row.player_id,
              status: row.status,
            },
          }),
          `battle.auto-terminal-whatsapp:${row.battle_id}`,
          row.battle_id,
        ],
      );
      if (inserted.rowCount === 1) projected += 1;
    }

    return { claimed: result.rows.length, projected };
  }
}
