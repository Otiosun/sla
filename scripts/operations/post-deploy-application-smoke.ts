import { createDatabasePool, closeDatabasePool } from "../../src/platform/db/database.js";
import { loadConfig } from "../../src/platform/config/env.js";
import { runPostDeployApplicationSmoke } from "../../src/operations/post-deploy-application-smoke.js";

const config = loadConfig();
if (config.appEnv !== "staging" && config.appEnv !== "production") {
  throw new Error("Post-deploy application smoke is restricted to staging/production");
}

const deploymentRevision = process.env.DEPLOY_REVISION;
if (deploymentRevision === undefined || deploymentRevision.length === 0) {
  throw new Error("DEPLOY_REVISION is required for post-deploy smoke evidence");
}
const whatsappSessionKey = process.env.WHATSAPP_SESSION_KEY;
if (whatsappSessionKey === undefined || whatsappSessionKey.length === 0) {
  throw new Error("WHATSAPP_SESSION_KEY is required for post-deploy smoke evidence");
}

const pool = createDatabasePool({
  connectionString: config.databaseUrl,
  applicationName: "pokemon-rpg-post-deploy-smoke",
  maxConnections: Math.min(config.databasePoolMax, 3),
  connectionTimeoutMs: config.databaseConnectTimeoutMs,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  queryTimeoutMs: config.databaseQueryTimeoutMs,
  statementTimeoutMs: config.databaseStatementTimeoutMs,
  idleInTransactionSessionTimeoutMs: config.databaseIdleInTransactionTimeoutMs,
});

try {
  const report = await runPostDeployApplicationSmoke(pool, {
    environment: config.appEnv,
    deploymentRevision,
    whatsappSessionKey,
  });
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally {
  await closeDatabasePool(pool);
}
