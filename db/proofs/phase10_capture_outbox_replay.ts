import { Pool } from "pg";
import { CaptureService } from "../../src/modules/capture/service.js";
import { HmacAesCaptureSeedProvider } from "../../src/platform/capture/hmac-aes-capture-seed-provider.js";
import { PostgresCaptureRepository } from "../../src/platform/capture/postgres-capture-repository.js";
import {
  createCorrelationId,
  parseEncounterId,
  parsePlayerId,
} from "../../src/shared-kernel/ids.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 10 outbox replay proof");
}

function unwrapId<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  try {
    const fixture = await pool.query<{
      player_id: string;
      encounter_id: string;
      ball_item_id: string;
      attempt_id: string;
      pokemon_instance_id: string | null;
      outbox_id: string;
      outbox_key: string;
      ball_balance: string;
      ledger_rows: string;
      attempt_rows: string;
      pokemon_rows: string;
      outbox_rows: string;
    }>(
      `SELECT identity.player_id,
              attempt.encounter_id,
              attempt.ball_item_id,
              attempt.id AS attempt_id,
              attempt.pokemon_instance_id,
              outbox.id AS outbox_id,
              outbox.idempotency_key AS outbox_key,
              balance.quantity::text AS ball_balance,
              (SELECT count(*)::text FROM inventory_ledger ledger
                 WHERE ledger.player_id = identity.player_id
                   AND ledger.idempotency_scope = 'capture.consume') AS ledger_rows,
              (SELECT count(*)::text FROM capture_attempts capture
                 WHERE capture.player_id = identity.player_id) AS attempt_rows,
              (SELECT count(*)::text FROM pokemon_instances pokemon
                 WHERE pokemon.owner_player_id = identity.player_id
                   AND pokemon.origin_type = 'CAPTURE') AS pokemon_rows,
              (SELECT count(*)::text FROM outbox_messages message
                 WHERE message.destination_ref = identity.player_id::text
                   AND message.message_type = 'CAPTURE_RESULT') AS outbox_rows
       FROM player_identities identity
       JOIN capture_attempts attempt
         ON attempt.player_id = identity.player_id
        AND attempt.status = 'CAPTURED'
       JOIN inventory_balances balance
         ON balance.player_id = identity.player_id
        AND balance.item_id = attempt.ball_item_id
       JOIN outbox_messages outbox
         ON outbox.idempotency_key = 'capture.result:' || attempt.id::text
       WHERE identity.provider = 'phase10-proof'
         AND identity.external_id = 'capture-success'
       ORDER BY attempt.created_at DESC
       LIMIT 1`,
    );
    const row = fixture.rows[0];
    if (row === undefined || row.pokemon_instance_id === null) {
      throw new Error("Phase 10 success fixture is missing before outbox replay proof");
    }

    await pool.query(
      `UPDATE outbox_messages
       SET status = 'FAILED', last_error_code = 'SIMULATED_DELIVERY_FAILURE'
       WHERE id = $1`,
      [row.outbox_id],
    );

    const service = new CaptureService(
      new PostgresCaptureRepository(pool),
      new HmacAesCaptureSeedProvider(Buffer.alloc(32, 0x31), Buffer.alloc(32, 0x52), 1),
    );
    const replay = await service.attempt({
      playerId: unwrapId("parse capture player", parsePlayerId(row.player_id)),
      encounterId: unwrapId("parse capture encounter", parseEncounterId(row.encounter_id)),
      expectedEncounterRevision: 0n,
      expectedBattleVersion: null,
      ballItemId: row.ball_item_id,
      idempotencyKey: "phase10-concurrent-success",
      correlationId: createCorrelationId(),
      causationId: null,
    });
    if (!replay.ok) {
      throw new Error(`Capture replay after delivery failure failed [${replay.error.code}]`);
    }
    if (
      !replay.value.replayed ||
      replay.value.status !== "CAPTURED" ||
      replay.value.captureAttemptId !== row.attempt_id ||
      replay.value.pokemonInstanceId !== row.pokemon_instance_id
    ) {
      throw new Error(
        `Delivery-failure retry did not replay the durable capture: ${JSON.stringify(replay.value)}`,
      );
    }

    const audit = await pool.query<{
      ball_balance: string;
      ledger_rows: string;
      attempt_rows: string;
      pokemon_rows: string;
      outbox_rows: string;
      outbox_status: string;
      last_error_code: string | null;
    }>(
      `SELECT
         (SELECT quantity::text FROM inventory_balances
            WHERE player_id = $1 AND item_id = $2) AS ball_balance,
         (SELECT count(*)::text FROM inventory_ledger
            WHERE player_id = $1 AND idempotency_scope = 'capture.consume') AS ledger_rows,
         (SELECT count(*)::text FROM capture_attempts WHERE player_id = $1) AS attempt_rows,
         (SELECT count(*)::text FROM pokemon_instances
            WHERE owner_player_id = $1 AND origin_type = 'CAPTURE') AS pokemon_rows,
         (SELECT count(*)::text FROM outbox_messages
            WHERE destination_ref = $1::text AND message_type = 'CAPTURE_RESULT') AS outbox_rows,
         (SELECT status FROM outbox_messages WHERE id = $3) AS outbox_status,
         (SELECT last_error_code FROM outbox_messages WHERE id = $3) AS last_error_code`,
      [row.player_id, row.ball_item_id, row.outbox_id],
    );
    const after = audit.rows[0];
    if (
      after === undefined ||
      after.ball_balance !== row.ball_balance ||
      after.ledger_rows !== row.ledger_rows ||
      after.attempt_rows !== row.attempt_rows ||
      after.pokemon_rows !== row.pokemon_rows ||
      after.outbox_rows !== row.outbox_rows ||
      after.outbox_status !== "FAILED" ||
      after.last_error_code !== "SIMULATED_DELIVERY_FAILURE"
    ) {
      throw new Error(
        `Delivery failure replay mutated capture mechanics: ${JSON.stringify({ before: row, after })}`,
      );
    }

    console.log(
      `Phase 10 outbox replay complete: failed delivery preserved one capture ${row.attempt_id} without re-executing mechanics`,
    );
  } finally {
    await pool.end();
  }
}

await main();
