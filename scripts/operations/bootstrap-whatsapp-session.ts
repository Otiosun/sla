import { createRequire } from "node:module";
import { Pool } from "pg";
import { makeSocket } from "../../src/adapters/whatsapp/baileys-runtime.js";
import { resolveLatestWhatsAppWebVersion } from "../../src/adapters/whatsapp/baileys-wa-web-version.js";
import { PostgresBaileysAuthBinding } from "../../src/adapters/whatsapp/postgres-baileys-auth.js";
import {
  resolveInstalledBaileysVersion,
  runWhatsAppPairingBootstrapCli,
  type TerminalQrRenderer,
} from "../../src/operations/whatsapp-pairing-bootstrap-cli.js";
import { runWhatsAppPairingBootstrap } from "../../src/operations/whatsapp-pairing-bootstrap.js";
import { loadConfig } from "../../src/platform/config/env.js";
import { assertDatabaseSchemaCurrent } from "../../src/platform/db/migrations.js";

const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal") as {
  generate(
    input: string,
    options: { readonly small: boolean },
    callback: (rendered: string) => void,
  ): void;
};

const renderQr: TerminalQrRenderer = (payload, callback) => {
  qrcodeTerminal.generate(payload, { small: true }, callback);
};

await runWhatsAppPairingBootstrapCli({
  env: process.env,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  isCI: process.env.CI !== undefined,
  resolveProviderVersion: resolveInstalledBaileysVersion,
  resolveWaWebVersion: resolveLatestWhatsAppWebVersion,
  renderQr,
  writeStdout: (chunk) => process.stdout.write(chunk),
  executePairing: async (config, providerVersion, waWebVersion, qrSink) => {
    const appConfig = loadConfig(process.env);
    const pool = new Pool({
      connectionString: appConfig.databaseUrl,
      application_name: "pokemon-rpg-whatsapp-pairing-bootstrap",
      max: 2,
      connectionTimeoutMillis: appConfig.databaseConnectTimeoutMs,
      idleTimeoutMillis: appConfig.databaseIdleTimeoutMs,
      query_timeout: appConfig.databaseQueryTimeoutMs,
      statement_timeout: appConfig.databaseStatementTimeoutMs,
      idle_in_transaction_session_timeout: appConfig.databaseIdleInTransactionTimeoutMs,
    });

    try {
      await assertDatabaseSchemaCurrent(pool);
      await runWhatsAppPairingBootstrap({
        config,
        providerVersion,
        waWebVersion,
        reserveBootstrap: (options) => PostgresBaileysAuthBinding.reserveBootstrap(pool, options),
        socketFactory: makeSocket,
        qrSink,
      });
    } finally {
      await pool.end();
    }
  },
});

const completeConfig = loadConfig(process.env);
process.stdout.write(
  `${JSON.stringify({
    event: "whatsapp.pairing.bootstrap.complete",
    environment: completeConfig.appEnv,
    sessionKey: process.env.WHATSAPP_SESSION_KEY ?? null,
    deploymentRevision: process.env.DEPLOY_REVISION ?? null,
  })}\n`,
);
