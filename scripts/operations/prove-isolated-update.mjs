import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { proveStatefulV4 } from "./v4-stateful-rehearsal.mjs";

// This rehearsal never accepts an existing cluster or connection string.
// It leaves its isolated cluster STOPPED for inspection; nothing is deleted.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [binaryDirectory, evidenceParent, mode] = process.argv.slice(2);
assert.ok(
  process.argv.length === 4 ||
    (process.argv.length === 5 &&
      ["--restore-only", "--scenes-only", "--v4-only", "--v4-rehearsal"].includes(mode)),
  "Usage: prove-isolated-update.mjs <pg-bin> <evidence-parent> [--restore-only|--scenes-only|--v4-only|--v4-rehearsal]",
);
assert.ok(binaryDirectory && evidenceParent);
const bin = resolve(binaryDirectory);
await mkdir(resolve(evidenceParent), { recursive: true });
if (mode === "--v4-rehearsal") {
  const disk = await statfs(resolve(evidenceParent));
  assert.ok(
    disk.bavail * disk.bsize >= 512 * 1024 * 1024,
    "Stateful rehearsal requires at least 512 MiB free before creating its cluster; no existing directory is deleted",
  );
}
const workspace = await mkdtemp(join(resolve(evidenceParent), "isolated-update-"));
const cluster = join(workspace, "cluster");
const executable = (name) => join(bin, name + (process.platform === "win32" ? ".exe" : ""));
const environment = {
  ...process.env,
  APP_ENV: "test",
  NODE_ENV: "test",
  WHATSAPP_ENABLED: "false",
  ALLOW_DISPOSABLE_POSTGRES_TESTS: "1",
};
// Never inherit service coordinates, migration URLs, credentials or libpq defaults.
for (const key of Object.keys(environment)) {
  if (
    /^(?:PG|DATABASE_URL$|MIGRATOR_DATABASE_URL$|POSTGRES_INTEGRATION_TEST_URL$|BACKUP_ENCRYPTION_KEY_B64$)/.test(
      key,
    )
  ) {
    delete environment[key];
  }
}
const commands = [];
let logIndex = 0;
async function command(program, args, extra = {}) {
  const result = spawnSync(program, args, {
    // A Windows postgres daemon can inherit captured pipe handles from pg_ctl.
    // Ignoring those handles lets startup return while its own logfile remains available.
    stdio: program === executable("pg_ctl") ? "ignore" : "pipe",
    cwd: root,
    env: { ...environment, ...extra },
    windowsHide: true,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = String(++logIndex).padStart(2, "0") + ".log";
  await writeFile(join(workspace, log), (result.stdout ?? "") + (result.stderr ?? ""));
  commands.push({
    program: program === process.execPath ? "node" : program,
    args,
    exitCode: result.status,
    log,
  });
  assert.equal(result.status, 0, "Proof command failed; inspect " + join(workspace, log));
  return result.stdout ?? "";
}
const socket = createServer();
await new Promise((yes, no) => {
  socket.once("error", no);
  socket.listen(0, "127.0.0.1", yes);
});
const port = socket.address().port;
await new Promise((yes) => socket.close(yes));
const url = (database) => "postgresql://pokemon@127.0.0.1:" + port + "/" + database;
const proof = {
  workspace,
  cluster,
  port,
  syntheticDataOnly: true,
  candidateMigrationPromoted: false,
  productionConnected: false,
  startedAt: new Date().toISOString(),
  commands,
  passed: false,
  clusterStopped: false,
};
let started = false;
let admin;
let source;
let recovered;
try {
  const version = await command(executable("postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 18\./);
  proof.postgresVersion = version.trim();
  await command(executable("initdb"), [
    "-D",
    cluster,
    "-U",
    "pokemon",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  // pg_ctl receives only the fresh, generated directory. No service manager is used.
  await command(executable("pg_ctl"), [
    "-D",
    cluster,
    "-l",
    join(workspace, "postgres.log"),
    "-o",
    "-h 127.0.0.1 -p " +
      port +
      " -c max_wal_size=64MB -c min_wal_size=32MB -c checkpoint_timeout=30s -c shared_buffers=32MB",
    "-w",
    "start",
  ]);
  started = true;
  environment.DATABASE_URL = url("postgres");
  environment.MIGRATOR_DATABASE_URL = url("postgres");
  environment.POSTGRES_INTEGRATION_TEST_URL = url("postgres");
  environment.SCENE_TRANSCRIPT_FILE = join(workspace, "scene-transcript.txt");
  if (mode === "--v4-rehearsal") environment.V4_REHEARSAL_CLONE_NAME = "beyond_v4_candidate";
  proof.databaseSuite =
    mode === "--restore-only"
      ? "NOT_RUN: explicit restore-only mode"
      : await command(process.execPath, [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--maxWorkers=1",
          "--hookTimeout=120000",
          "--testTimeout=120000",
          ...(["--v4-only", "--v4-rehearsal"].includes(mode)
            ? [
                "tests/uat/headless-narrator-pve.integration.test.ts",
                "tests/messaging/uat-completion-postgres.test.ts",
              ]
            : mode === "--scenes-only"
              ? [
                  "tests/db/combat-scene-gate.integration.test.ts",
                  "tests/uat/headless-narrator-pve.integration.test.ts",
                  "tests/battle/combat-scene-message.test.ts",
                  "tests/battle/combat-scene-gate.test.ts",
                ]
              : [
                  "tests/db/combat-scene-gate.integration.test.ts",
                  "tests/db/solo-expedition-repository.integration.test.ts",
                  "tests/db/world-service-fishing-attempt-repository.integration.test.ts",
                  "tests/db/world-service-pc-storage.integration.test.ts",
                  "tests/db/roster-placement-30-slot-boxes.integration.test.ts",
                  "tests/db/pvp-challenge-repository.integration.test.ts",
                  "tests/db/pvp-turn-resolution.integration.test.ts",
                  "tests/db/pvp-mutation-admission.integration.test.ts",
                  "tests/db/premium-http-lifecycle.integration.test.ts",
                  "tests/uat/headless-narrator-pve.integration.test.ts",
                  "tests/capture",
                  "tests/battle",
                  "tests/encounter",
                  "tests/messaging",
                  "tests/exploration",
                  "tests/pvp",
                ]),
        ]);
  if (mode === "--v4-rehearsal")
    await proveStatefulV4({ workspace, port, url, command, executable, proof });
  if (mode !== "--scenes-only" && mode !== "--v4-only") {
    admin = new Pool({ connectionString: url("postgres"), max: 1 });
    await admin.query("CREATE DATABASE beyond_rehearsal_before");
    await admin.query("CREATE DATABASE beyond_rehearsal_restored");
    source = new Pool({ connectionString: url("beyond_rehearsal_before"), max: 1 });
    await command(process.execPath, ["--import", "tsx", "src/platform/db/cli.ts", "migrate"], {
      DATABASE_URL: url("beyond_rehearsal_before"),
      MIGRATOR_DATABASE_URL: url("beyond_rehearsal_before"),
    });
    const player = randomUUID();
    await source.query("INSERT INTO players(id,status) VALUES($1,'ACTIVE')", [player]);
    // Explicitly synthetic history: exercise instance identity, IVs, PP, HP, XP,
    // Team/Box placement, inventory and immutable event payloads in the restore.
    const species = randomUUID();
    const form = randomUUID();
    const move = randomUUID();
    const item = randomUUID();
    await source.query(
      "INSERT INTO pokemon_species(id,national_dex,slug) VALUES($1,1,'synthetic-restore-species')",
      [species],
    );
    await source.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES($1,$2,'default')", [
      form,
      species,
    ]);
    await source.query("INSERT INTO moves(id,slug) VALUES($1,'synthetic-restore-move')", [move]);
    await source.query("INSERT INTO items(id,slug) VALUES($1,'synthetic-restore-item')", [item]);
    for (let index = 0; index < 3; index += 1) {
      const pokemon = randomUUID();
      await source.query(
        "INSERT INTO pokemon_instances(id,owner_player_id,form_id,level,xp,current_hp,shiny,origin_type,metadata,revision) VALUES($1,$2,$3,5,123,17,$4,'TEST',$5::jsonb,7)",
        [
          pokemon,
          player,
          form,
          index === 0,
          JSON.stringify({ synthetic: true, history: "antes da atualização — não publicar" }),
        ],
      );
      await source.query(
        "INSERT INTO pokemon_training_values(pokemon_instance_id,iv_hp,iv_attack,iv_defense,iv_sp_attack,iv_sp_defense,iv_speed) VALUES($1,31,7,18,22,13,0)",
        [pokemon],
      );
      await source.query(
        "INSERT INTO pokemon_move_slots(pokemon_instance_id,slot_no,move_id,pp_current) VALUES($1,1,$2,11)",
        [pokemon, move],
      );
      await source.query(
        "INSERT INTO pokemon_roster_slots(pokemon_instance_id,player_id,placement_kind,box_no,slot_no) VALUES($1,$2,$3,$4,$5)",
        [
          pokemon,
          player,
          index < 2 ? "TEAM" : "BOX",
          index < 2 ? null : 2,
          index < 2 ? index + 1 : 30,
        ],
      );
      await source.query(
        "INSERT INTO pokemon_history_events(id,pokemon_instance_id,event_type,payload,actor_type) VALUES($1,$2,'TEST',$3::jsonb,'SYSTEM')",
        [randomUUID(), pokemon, JSON.stringify({ synthetic: true, xp: 123, moveId: move })],
      );
    }
    await source.query(
      "INSERT INTO inventory_balances(player_id,item_id,quantity,revision) VALUES($1,$2,9,4)",
      [player, item],
    );
    await source.query(
      "INSERT INTO inventory_ledger(id,player_id,item_id,delta,source_type,source_id,reason,actor_type,idempotency_scope,idempotency_key,correlation_id) VALUES($1,$2,$3,9,'TEST','synthetic-restore','Synthetic restore fixture','SYSTEM','synthetic-restore','before',$4)",
      [randomUUID(), player, item, randomUUID()],
    );
    proof.syntheticPokemonCount = 3;
    // Snapshot EVERY public table, including migration checksums, in stable row order.
    async function databaseSnapshot(pool) {
      const tables = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      );
      const snapshot = {};
      for (const { tablename } of tables.rows) {
        const identifier = '"' + tablename.replaceAll('"', '""') + '"';
        const rows = await pool.query(
          "SELECT to_jsonb(t) AS row FROM public." + identifier + " t ORDER BY to_jsonb(t)::text",
        );
        snapshot[tablename] = rows.rows.map((entry) => entry.row);
      }
      return snapshot;
    }
    const before = await databaseSnapshot(source);
    proof.baselineTableCount = Object.keys(before).length;
    proof.baselineDigest = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    proof.migrationCount = (
      await source.query("SELECT count(*)::int AS n FROM schema_migrations")
    ).rows[0].n;
    const dump = join(workspace, "before.dump");
    await command(executable("pg_dump"), [
      "--host=127.0.0.1",
      "--port=" + port,
      "--username=pokemon",
      "--dbname=beyond_rehearsal_before",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file=" + dump,
    ]);
    const key = randomBytes(32).toString("base64");
    const encrypted = join(workspace, "before.pbv4");
    const decrypted = join(workspace, "verified.dump");
    await command(
      process.execPath,
      ["scripts/operations/backup-envelope.mjs", "encrypt", dump, encrypted],
      { BACKUP_ENCRYPTION_KEY_B64: key },
    );
    await command(
      process.execPath,
      ["scripts/operations/backup-envelope.mjs", "decrypt", encrypted, decrypted],
      {
        BACKUP_ENCRYPTION_KEY_B64: key,
        ALLOW_DISPOSABLE_BACKUP_RESTORE: "1",
      },
    );
    assert.deepEqual(await readFile(decrypted), await readFile(dump));
    // Simulate update on this disposable COPY: active chain + candidate DDL.
    const candidates = [
      "0080_solo_exploration_v4.sql",
      "0081_combat_scene_gate.sql",
      "0082_pvp_group_timing.sql",
      "0083_expedition_reports.sql",
      "0084_expedition_search_targets.sql",
      "0085_expedition_world_service_admission.sql",
      "0086_expedition_fishing_encounters.sql",
      "0087_mart_trade_receipts.sql",
    ];
    proof.candidateSchemas = [];
    await source.query("BEGIN");
    try {
      for (const file of candidates) {
        const ddl = await readFile(join(root, "db/candidates", file), "utf8");
        await source.query(ddl);
        proof.candidateSchemas.push({
          file,
          sha256: createHash("sha256").update(ddl).digest("hex"),
        });
      }
      await source.query("COMMIT");
    } catch (error) {
      await source.query("ROLLBACK");
      throw error;
    }
    const afterDDL = await databaseSnapshot(source);
    for (const [table, rows] of Object.entries(before))
      assert.deepEqual(
        afterDDL[table].map((row) =>
          Object.fromEntries(Object.keys(rows[0] ?? row).map((key) => [key, row[key]])),
        ),
        rows,
        "Legacy rows changed during additive candidate upgrade: " + table,
      );
    proof.legacyRowsPreservedAcrossCandidateDDL = true;
    assert.equal(
      (
        await source.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'solo_%'",
        )
      ).rows[0].n,
      14,
    );
    await source.query("UPDATE players SET status='SUSPENDED', revision=revision+1 WHERE id=$1", [
      player,
    ]);
    // Rollback is recovery into a clean clone, NOT destructive down-migrations.
    await command(executable("pg_restore"), [
      "--host=127.0.0.1",
      "--port=" + port,
      "--username=pokemon",
      "--dbname=beyond_rehearsal_restored",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      decrypted,
    ]);
    recovered = new Pool({ connectionString: url("beyond_rehearsal_restored"), max: 1 });
    assert.deepEqual(await databaseSnapshot(recovered), before);
    assert.equal(
      (await source.query("SELECT status FROM players WHERE id=$1", [player])).rows[0].status,
      "SUSPENDED",
    );
    assert.equal(
      (await recovered.query("SELECT status FROM players WHERE id=$1", [player])).rows[0].status,
      "ACTIVE",
    );
    proof.fullRestoreMatched = true;
  }
  proof.passed = true;
} catch (error) {
  proof.error = error.message;
  process.exitCode = 1;
} finally {
  await Promise.all([source?.end(), recovered?.end(), admin?.end()]);
  if (started) {
    try {
      await command(executable("pg_ctl"), ["-D", cluster, "-m", "fast", "-w", "stop"]);
      proof.clusterStopped = true;
    } catch (error) {
      proof.stopError = error.message;
      process.exitCode = 1;
    }
  }
  proof.finishedAt = new Date().toISOString();
  await writeFile(join(workspace, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
  // The ephemeral key is intentionally never persisted. Encrypted fixture is not a production backup.
  console.log(
    JSON.stringify({
      evidence: join(workspace, "proof.json"),
      passed: proof.passed,
      clusterStopped: proof.clusterStopped,
      error: proof.error,
    }),
  );
}
