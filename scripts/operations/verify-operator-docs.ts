import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ADMIN_ROLE_CAPABILITIES } from "../../src/modules/admin/registry-catalog.js";

const ROOT = process.cwd();
const MANUAL = "docs/operations/admin-operator-manual.md";
const RUNBOOK = "docs/operations/release-recovery-runbook.md";

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
  const [manual, runbook] = await Promise.all([read(MANUAL), read(RUNBOOK)]);

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

  await Promise.all([
    requirePath("scripts/operations/release-migrate.sh"),
    requirePath("db/bootstrap/runtime_grants.sql"),
    requirePath("scripts/operations/bootstrap-initial-admin.ts"),
  ]);

  await Promise.all([verifyLinkedOperationalDocs(manual), verifyLinkedOperationalDocs(runbook)]);

  console.log(
    JSON.stringify({
      event: "operator_docs.verified",
      adminRoles: Object.keys(ADMIN_ROLE_CAPABILITIES).length,
      manual: MANUAL,
      runbook: RUNBOOK,
    }),
  );
}

await main();
