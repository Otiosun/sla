import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";

assert.equal(process.env.APP_ENV, "test");
assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.WHATSAPP_ENABLED, "false");
assert.equal(process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS, "1");
assert.equal(process.env.V4_REHEARSAL_SYNTHETIC, "1");
const restored = new URL(process.env.V4_RESTORED_URL!);
const maintenance = new URL(process.env.POSTGRES_INTEGRATION_TEST_URL!);
assert.equal(restored.host, maintenance.host);
assert.equal(restored.username, "pokemon");
assert.equal(restored.pathname, "/beyond_v4_restored");
assert.equal(maintenance.pathname, "/postgres");
assert.equal(restored.hostname, "127.0.0.1");
const pool = new Pool({ connectionString: restored.toString(), max: 6 });
const player = "5511999990004@s.whatsapp.net",
  group = "120363777700000001@g.us";
const config = {
  pool,
  encounterRngConfig: { encryptionKey: Buffer.alloc(32, 0x4c), encryptionKeyVersion: 1 },
  pveBattleConfig: {
    turnWindowTtlMs: 60000,
    maintenanceBatchSize: 8,
    encryptionKeys: new Map([[1, Buffer.alloc(32, 0x4c)]]),
  },
  combatScenesEnabled: true,
  explorationPreviewTimeZone: "America/Sao_Paulo",
  explorationStagingPreparationEnabled: true,
  explorationStagingSearchSecret: Buffer.alloc(32, 0x72),
  explorationOfflineChoicesEnabled: true,
  explorationStagingResourcesEnabled: true,
  explorationStagingTrailEnabled: true,
};
let runtime = createOperationalSimulatedWhatsAppRuntime(config);
try {
  const identities = await pool.query<{ player_id: string }>(
    "SELECT player_id FROM player_identities WHERE provider='baileys' AND external_id=$1 AND status='ACTIVE'",
    [player],
  );
  assert.equal(identities.rows.length, 1);
  const id = identities.rows[0]!.player_id;
  const pokemon = async () =>
    (
      await pool.query(
        "SELECT id,xp::text,current_hp FROM pokemon_instances WHERE owner_player_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
  const unchanged = await pokemon();
  const preparation = (
    await pool.query(
      "SELECT id,phase,elapsed_minutes FROM solo_expeditions WHERE player_id=$1 AND phase='PREPARING'",
      [id],
    )
  ).rows[0];
  assert.ok(preparation);
  const effects = async () =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_ledger WHERE player_id=$1 AND source_type='EXPEDITION_REPORT'",
        [id],
      )
    ).rows[0].n;
  const grants = await effects();
  assert.equal(grants, 2);
  await runtime.runtime.start();
  const input = await runtime.adapter.injectText({
    senderRef: player,
    chatRef: group,
    text: "/explorar recursos",
    externalMessageId: "restore-resources-once",
  });
  await runtime.runtime.flushOutbox();
  const after = async () =>
    (
      await pool.query(
        "SELECT phase,elapsed_minutes,revision::text,consumed_week_key::text FROM solo_expeditions WHERE id=$1",
        [preparation.id],
      )
    ).rows[0];
  const committed = await after();
  assert.equal(committed.phase, "ACTIVE");
  assert.equal(committed.elapsed_minutes, 60);
  await runtime.runtime.stop();
  runtime = createOperationalSimulatedWhatsAppRuntime(config);
  await runtime.runtime.start();
  await runtime.adapter.inject(input);
  await runtime.runtime.flushOutbox();
  assert.deepEqual(await after(), committed);
  assert.equal(await effects(), grants);
  assert.deepEqual(await pokemon(), unchanged);
  const evidence = {
    restoredPreparationResumed: true,
    sameInputAfterRestartReplayed: true,
    oldPokemonPreserved: true,
    approvedReportNotRegranted: true,
    elapsedMinutes: 60,
  };
  if (process.env.V4_RESUME_EVIDENCE)
    await writeFile(process.env.V4_RESUME_EVIDENCE, JSON.stringify(evidence, null, 2));
} finally {
  await runtime.runtime.stop();
  await pool.end();
}
