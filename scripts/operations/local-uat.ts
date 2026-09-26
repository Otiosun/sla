import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { decryptWhatsAppAuthValue } from "../../src/adapters/whatsapp/whatsapp-auth-crypto.js";
import { type LocalUatTarget, localUatEnvironment } from "../../src/operations/local-uat-config.js";
import { loadConfig } from "../../src/platform/config/env.js";
import { assertDatabaseSchemaCurrent } from "../../src/platform/db/migrations.js";
import { loadEncounterRngRuntimeConfig } from "../../src/runtime/encounter-rng-runtime-config.js";
import { loadWhatsAppRuntimeConfig } from "../../src/runtime/whatsapp-runtime-config.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
const local = new URL("../../.local-uat/", import.meta.url);
const pipe =
  process.platform === "win32"
    ? `\\\\.\\pipe\\pokemon-uat-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
    : fileURLToPath(new URL("control.sock", local));
const event = (name: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event: name, ...data }));

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "stop") {
    const control = JSON.parse(await readFile(new URL("control.json", local), "utf8")) as {
      token: string;
    };
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(pipe);
      socket.setTimeout(5000, () => socket.destroy(new Error("CONTROL_TIMEOUT")));
      socket.on("error", reject);
      socket.on("connect", () => socket.write(`${control.token}\n`));
      socket.on("data", (data) => {
        socket.end();
        if (data.toString() === "STOPPING") resolve();
        else reject(new Error("CONTROL_REJECTED"));
      });
    });
    event("local.uat.stop_requested");
    return;
  }
  if (command !== "verify" && command !== "start") throw new Error("LOCAL_UAT_COMMAND_INVALID");
  const snapshot = JSON.parse(
    await readFile(new URL("runtime-environment.json", local), "utf8"),
  ) as Record<string, string>;
  const target = JSON.parse(
    await readFile(new URL("target.json", local), "utf8"),
  ) as LocalUatTarget;
  const env = localUatEnvironment(snapshot, target);
  const config = loadConfig(env);
  loadEncounterRngRuntimeConfig(env);
  const whatsapp = loadWhatsAppRuntimeConfig(config, env);
  if (!whatsapp) throw new Error("LOCAL_UAT_SESSION_MISSING");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    options: "-c default_transaction_read_only=on",
  });
  try {
    const connection = (
      await pool.query(`SELECT current_user AS role,current_database() AS database,inet_server_port() AS port,
      has_schema_privilege(current_user,'public','CREATE') AS can_create,
      (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`)
    ).rows[0];
    if (
      connection.role !== "pokemon_runtime" ||
      connection.database !== target.database ||
      connection.port !== target.port ||
      connection.can_create ||
      connection.elevated
    )
      throw new Error("LOCAL_UAT_ROLE_VERIFICATION_FAILED");
    await assertDatabaseSchemaCurrent(pool);
    const ownership = (
      await pool.query(
        `SELECT count(*)::int AS invalid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m') AND r.rolname <> 'pokemon_migrator'`,
      )
    ).rows[0];
    if (ownership.invalid !== 0) throw new Error("LOCAL_UAT_OWNERSHIP_MISMATCH");
    const session = (
      await pool.query(
        `SELECT credentials_ciphertext,credentials_iv,credentials_auth_tag,encryption_key_version FROM whatsapp_auth_sessions WHERE session_key=$1`,
        [whatsapp.sessionKey],
      )
    ).rows[0];
    if (!session || session.encryption_key_version !== whatsapp.authEncryptionKeyVersion)
      throw new Error("LOCAL_UAT_EXISTING_SESSION_MISMATCH");
    decryptWhatsAppAuthValue(
      {
        ciphertext: session.credentials_ciphertext,
        iv: session.credentials_iv,
        authTag: session.credentials_auth_tag,
      },
      whatsapp.authEncryptionKey,
      `whatsapp-auth:${whatsapp.sessionKey}:credentials`,
    );
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const sourceHash = createHash("sha256");
    for (const path of [
      "src/modules/admin/uat-bootstrap.ts",
      "src/modules/messaging/service.ts",
      "src/runtime/compose-whatsapp-runtime.ts",
    ])
      sourceHash.update(await readFile(new URL(`../../${path}`, import.meta.url)));
    event("local.uat.verified", {
      databaseRole: connection.role,
      schemaCurrent: true,
      existingSessionDecrypts: true,
      revision,
      sourceHash: sourceHash.digest("hex"),
      worktree: root,
    });
    // The new instance should attest the code it actually runs, not an inherited SHA.
    env.DEPLOY_REVISION = revision;
  } finally {
    await pool.end();
  }
  if (command === "verify") return;
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.once("data", (data) => {
      if (data.toString().trim() !== token || process.listenerCount("SIGTERM") === 0) {
        socket.end("REJECTED");
        return;
      }
      socket.end("STOPPING");
      process.emit("SIGTERM");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  try {
    await writeFile(new URL("control.json", local), JSON.stringify({ pid: process.pid, token }), {
      mode: 0o600,
    });
    for (const key of Object.keys(process.env)) {
      if (
        /^(APP_ENV|LOG_LEVEL|DEPLOY_REVISION|DATABASE_.*|MIGRATOR_DATABASE_URL|RUNTIME_DATABASE_URL|WHATSAPP_.*|ENCOUNTER_.*|PVE_.*|PVP_.*|WORLD_.*)$/.test(
          key,
        )
      )
        delete process.env[key];
    }
    Object.assign(process.env, env);
    await import("../../src/main.js");
  } finally {
    server.close();
  }
}

try {
  await main();
} catch {
  // Never render raw exceptions: drivers/config validators may contain secrets.
  event("local.uat.failed");
  process.exitCode = 1;
}
