import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

async function snapshot(pool) {
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  const result = {};
  for (const { tablename } of tables.rows) {
    const identifier = '"' + tablename.replaceAll('"', '""') + '"';
    result[tablename] = (
      await pool.query(
        "SELECT to_jsonb(t) AS row FROM public." + identifier + " t ORDER BY to_jsonb(t)::text",
      )
    ).rows.map((x) => x.row);
  }
  return result;
}
/** Invoked only inside the fresh-cluster owner; no existing URL CLI accepted. */
export async function proveStatefulV4({ workspace, port, url, command, executable, proof }) {
  const admin = new Pool({ connectionString: url("postgres"), max: 1 });
  const source = new Pool({ connectionString: url("beyond_v4_candidate"), max: 1 });
  let restored;
  try {
    const state = await snapshot(source);
    const pending = {
      preparation: (
        await source.query(
          "SELECT count(*)::int AS n FROM solo_expeditions WHERE phase='PREPARING' AND consumed_week_key IS NULL",
        )
      ).rows[0].n,
      scene: (
        await source.query(
          "SELECT count(*)::int AS n FROM combat_scene_gates WHERE record->'result'='null'::jsonb AND record->'action'<>'null'::jsonb AND record->'sceneMessageId'='null'::jsonb",
        )
      ).rows[0].n,
      report: (
        await source.query(
          "SELECT count(*)::int AS n FROM solo_expedition_reports WHERE status='SUBMITTED'",
        )
      ).rows[0].n,
      approvedReport: (
        await source.query(
          "SELECT count(*)::int AS n FROM solo_expedition_reports WHERE status='APPROVED'",
        )
      ).rows[0].n,
    };
    for (const [kind, count] of Object.entries(pending))
      assert.ok(count > 0, "Missing stateful fixture: " + kind);
    const dump = join(workspace, "v4-pending.dump"),
      encrypted = join(workspace, "v4-pending.pbv4"),
      decrypted = join(workspace, "v4-pending-verified.dump");
    const connection = ["--host=127.0.0.1", "--port=" + port, "--username=pokemon"];
    await command(executable("pg_dump"), [
      ...connection,
      "--dbname=beyond_v4_candidate",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file=" + dump,
    ]);
    const key = randomBytes(32).toString("base64");
    await command(
      process.execPath,
      ["scripts/operations/backup-envelope.mjs", "encrypt", dump, encrypted],
      { BACKUP_ENCRYPTION_KEY_B64: key },
    );
    await command(
      process.execPath,
      ["scripts/operations/backup-envelope.mjs", "decrypt", encrypted, decrypted],
      { BACKUP_ENCRYPTION_KEY_B64: key, ALLOW_DISPOSABLE_BACKUP_RESTORE: "1" },
    );
    assert.deepEqual(await readFile(dump), await readFile(decrypted));
    await admin.query("CREATE DATABASE beyond_v4_restored");
    await command(executable("pg_restore"), [
      ...connection,
      "--dbname=beyond_v4_restored",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      decrypted,
    ]);
    restored = new Pool({ connectionString: url("beyond_v4_restored"), max: 1 });
    assert.deepEqual(await snapshot(restored), state);
    proof.statefulV4 = {
      pending,
      tableCount: Object.keys(state).length,
      digest: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
      fullRestoreMatched: true,
      resumed: false,
    };
    await command(
      process.execPath,
      ["--import", "tsx", "scripts/operations/resume-v4-rehearsal.ts"],
      {
        V4_RESTORED_URL: url("beyond_v4_restored"),
        V4_REHEARSAL_SYNTHETIC: "1",
        V4_RESUME_EVIDENCE: join(workspace, "v4-resume.json"),
      },
    );
    proof.statefulV4.resumed = true;
    await writeFile(
      join(workspace, "v4-stateful-summary.json"),
      JSON.stringify(proof.statefulV4, null, 2),
    );
  } finally {
    await Promise.all([admin.end(), source.end(), restored?.end()]);
  }
}
