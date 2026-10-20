#!/usr/bin/env node
/**
 * Read-only operator check. Never connects to the DB/WhatsApp, starts a worker,
 * prints secrets, executes migrations, or writes local files.
 * Usage: node --env-file-if-exists=.env scripts/operations/premium-local-readiness.mjs
 */
import { spawnSync } from "node:child_process";

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 3000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

const env = process.env;
const nodeMajor = Number(process.versions.node.split(".")[0]);
const host = env.PLAYER_PORTAL_HOST ?? "0.0.0.0";
const localMode = env.PREMIUM_LOCAL_DELIVERY_ENABLED === "1";
const appEnv = env.APP_ENV ?? "development";
const signingKey = env.PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64;
const key = signingKey ? Buffer.from(signingKey.trim(), "base64") : null;
const keyValid = !!(key && key.length === 32 && key.toString("base64") === signingKey.trim());
const dbConfigured = (() => {
  try {
    const u = new URL(env.DATABASE_URL ?? "");
    return ["postgresql:", "postgres:"].includes(u.protocol) && !!u.hostname && !!u.pathname;
  } catch {
    return false;
  }
})();
const head = git("rev-parse", "HEAD");
const branch = git("branch", "--show-current");
const changes = git("status", "--porcelain");
const required = {
  node24OrNewer: Number.isInteger(nodeMajor) && nodeMajor >= 24,
  gitWorkingTreeReadable: head !== null && changes !== null,
  supportedLocalEnvironment: appEnv === "development" || appEnv === "production",
  loopbackOnlyHttp: host === "127.0.0.1" || host === "::1",
  premiumOptInExplicit: localMode,
  databaseUrlConfigured: dbConfigured,
  portalSigningKeyCanonical32Bytes: keyValid,
  productionRevisionConfigured:
    appEnv !== "production" || /^[0-9a-f]{40}$/.test(env.DEPLOY_REVISION ?? ""),
};
const report = {
  event: "pokemon.premium.local.readiness",
  readOnly: true,
  application: "NOT_PERFORMED",
  botRestarted: false,
  databaseContacted: false,
  whatsappContacted: false,
  revision: head && /^[0-9a-f]{40}$/.test(head) ? head : null,
  branch: branch ?? null,
  worktreeHasChanges: changes === null ? null : changes.length > 0,
  checks: required,
  readyForOperatorReview: Object.values(required).every(Boolean) && changes === "",
  operatorGatesNotAutomated: [
    "confirm_this_is_the_current_running_bot_copy",
    "verify_DATABASE_URL_target_without_sharing_credentials",
    "review_migration_0072_role_changes",
    "prove_backup_restoration_before_migrations",
    "approve_local_API_activation_and_site_tunnel_separately",
  ],
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
// Return nonzero when not prepared. Never change the system to make a check pass.
if (!report.readyForOperatorReview) process.exitCode = 2;
