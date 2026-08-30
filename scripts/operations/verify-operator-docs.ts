import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ADMIN_ROLE_CAPABILITIES } from "../../src/modules/admin/registry-catalog.js";

const ROOT = process.cwd();
const MANUAL = "docs/operations/admin-operator-manual.md";
const RUNBOOK = "docs/operations/release-recovery-runbook.md";
const WHATSAPP_PAIRING = "docs/operations/whatsapp-first-pairing.md";

async function read(path: string): Promise<string> {
  return readFile(resolve(ROOT, path), "utf8");
}

function requireTokens(path: string, content: string, tokens: readonly string[]): void {
  const missing = tokens.filter((token) => !content.includes(token));
  if (missing.length > 0) {
    throw new Error(`${path} is missing required operator contract tokens: ${missing.join(", ")}`);
  }
}

function requireExactAdminRoleTable(content: string): void {
  const documented = [...content.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)]
    .map((match) => match[1])
    .filter((role): role is string => role !== undefined)
    .sort();
  const expected = Object.keys(ADMIN_ROLE_CAPABILITIES).sort();

  const duplicates = documented.filter((role, index) => documented.indexOf(role) !== index);
  const missing = expected.filter((role) => !documented.includes(role));
  const unknown = documented.filter((role) => !expected.includes(role));
  if (duplicates.length > 0 || missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${MANUAL} role table differs from ADMIN_ROLE_CAPABILITIES: missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}], duplicates=[${[...new Set(duplicates)].join(", ")}]`,
    );
  }
}

async function requirePath(path: string): Promise<void> {
  await access(resolve(ROOT, path));
}

async function verifyLinkedOperationalDocs(content: string): Promise<void> {
  const matches = content.matchAll(/`(docs\/operations\/[A-Za-z0-9._/-]+\.md)`/g);
  const paths = new Set([...matches].map((match) => match[1]).filter(Boolean) as string[]);
  for (const path of paths) await requirePath(path);
}

async function main(): Promise<void> {
  const [manual, runbook, whatsappPairing] = await Promise.all([
    read(MANUAL),
    read(RUNBOOK),
    read(WHATSAPP_PAIRING),
  ]);

  requireExactAdminRoleTable(manual);
  requireTokens(MANUAL, manual, [
    "GLOBAL",
    "PLAYER",
    "REGION",
    "AREA",
    "idempotencyKey",
    "correlationId",
    "expectedRevision",
    "simulate",
    "confirm",
    "approve",
    "apply",
    "Player360",
    "inventory.adjust",
    "wallet.adjust",
    "progression.trainer.adjust",
    "admin.role.assign",
    "admin.override.invariant",
    "initial-admin-bootstrap.md",
    "release-recovery-runbook.md",
  ]);

  requireTokens(RUNBOOK, runbook, [
    "release-migrate.sh",
    "runtime_grants.sql",
    "pnpm db:verify",
    "initial-admin-bootstrap.md",
    "whatsapp-first-pairing.md",
    "pnpm ops:bootstrap:whatsapp",
    "backup-restore.md",
    "disaster-recovery.md",
    "incident-response.md",
    "observability-alerting.md",
    "admin-operator-manual.md",
    "pg_restore",
    "sha256sum",
    "replacement",
    "Do not execute a destructive automatic down-migration chain",
    "17.2",
    "17.3",
    "17.5",
  ]);

  requireTokens(WHATSAPP_PAIRING, whatsappPairing, [
    "one-shot bootstrap ceremony",
    "7.0.0-rc14",
    "pnpm ops:bootstrap:whatsapp",
    "WHATSAPP_PAIRING_TIMEOUT_MS",
    "local interactive TTY",
    "connection=open",
    "registered credentials",
    "atomically persist",
    "no partially bootstrapped session",
    "finalPostDeploySmokeComplete=true",
    "incident-response.md",
    "release-recovery-runbook.md",
  ]);

  await Promise.all([
    requirePath("scripts/operations/release-migrate.sh"),
    requirePath("db/bootstrap/runtime_grants.sql"),
    requirePath("scripts/operations/bootstrap-initial-admin.ts"),
    requirePath("scripts/operations/bootstrap-whatsapp-session.ts"),
  ]);

  await Promise.all([
    verifyLinkedOperationalDocs(manual),
    verifyLinkedOperationalDocs(runbook),
    verifyLinkedOperationalDocs(whatsappPairing),
  ]);

  console.log(
    JSON.stringify({
      event: "operator_docs.verified",
      adminRoles: Object.keys(ADMIN_ROLE_CAPABILITIES).length,
      manual: MANUAL,
      runbook: RUNBOOK,
      whatsappPairing: WHATSAPP_PAIRING,
    }),
  );
}

await main();
