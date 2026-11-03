import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const current = dirname(fileURLToPath(import.meta.url));
const program = join(current, "../../scripts/operations/prepare-windows-candidate.mjs");
const SHA = "a".repeat(40);
const VERIFY = join(current, "../../scripts/operations/verify-windows-candidate.mjs");

function verify(output, sha = SHA) {
  return spawnSync(process.execPath, [VERIFY, output, sha], {
    encoding: "utf8",
    timeout: 12_000,
  });
}

function run(root, output, values = {}) {
  return spawnSync(process.execPath, [program, root, output], {
    env: {
      ...process.env,
      CI: "true",
      APP_ENV: "test",
      WHATSAPP_ENABLED: "false",
      GITHUB_SHA: SHA,
      ...values,
    },
    encoding: "utf8",
    timeout: 12_000,
  });
}

async function fixture(root) {
  const contents = {
    "dist/src/main.js": "console.log('isolated proof')",
    "package.json": JSON.stringify({
      packageManager: "pnpm@11.23.0",
      engines: { node: "24.19.0" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "db/migrations/0079_stage2_move_acquisition_methods.sql": "-- synthetic",
    "scripts/operations/release-local-readonly-preflight.ps1": "Write-Output 'read-only'",
    "scripts/operations/verify-windows-candidate.mjs": await readFile(VERIFY, "utf8"),
    ".env.production": "PRIVATE-SHOULD-BE-EXCLUDED",
    "auth_info_baileys/creds.json": "PRIVATE-SESSION-SHOULD-BE-EXCLUDED",
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

test("Windows bundle copies only audited artifacts, verifies digests and never installs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beyond-windows-candidate-"));
  try {
    const root = join(dir, "checkout");
    const out = join(dir, "candidate");
    await mkdir(root);
    await fixture(root);
    const built = run(root, out);
    assert.equal(built.status, 0, built.stderr);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.gitSha, SHA);
    assert.equal(manifest.result, "NO_GO_INSPECTION_ONLY");
    assert.equal(manifest.v4MigrationActive, false);
    assert.equal(manifest.dependenciesIncluded, false);
    assert.equal(manifest.files.length, 7);
    assert.equal(verify(out).status, 0);
    assert.notEqual(verify(out, "b".repeat(40)).status, 0);
    for (const entry of manifest.files) {
      const data = await readFile(join(out, entry.path));
      assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256);
      assert.equal(data.length, entry.bytes);
    }
    const printed = JSON.stringify(manifest);
    assert.equal(printed.includes("PRIVATE-"), false);
    await assert.rejects(stat(join(out, ".env.production")));
    await assert.rejects(stat(join(out, "auth_info_baileys")));
    assert.notEqual(run(root, out).status, 0);
    const changed = join(out, "package.json");
    const original = await readFile(changed);
    await writeFile(changed, '{"tampered":true}');
    assert.notEqual(verify(out).status, 0);
    await writeFile(changed, original);
    await writeFile(join(out, "unknown-file.txt"), "not in the manifest");
    assert.notEqual(verify(out).status, 0);
    await rm(join(out, "unknown-file.txt"));
    assert.equal(verify(out).status, 0);
    assert.notEqual(run(root, join(dir, "not-ci"), { CI: "false" }).status, 0);
    assert.notEqual(run(root, join(dir, "wrong-sha"), { GITHUB_SHA: "unknown" }).status, 0);
    assert.notEqual(run(root, join(root, "dist", "output")).status, 0);
    await symlink(join(root, ".env.production"), join(root, "dist", "private.txt"));
    assert.notEqual(run(root, join(dir, "symlink-refused")).status, 0);
    await assert.rejects(stat(join(dir, "symlink-refused")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
