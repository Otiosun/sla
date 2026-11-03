import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PRIVATE = /(^|\/)(?:\.env(?:\.[^/]*)?|auth_info_baileys|node_modules|\.git|\.npmrc|\.ssh|\.aws)(?:\/|$)/iu;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

async function walk(directory, root) {
  const files = [];
  const entries = (await readdir(directory)).sort();
  for (const name of entries) {
    const full = join(directory, name);
    const info = await lstat(full);
    assert.ok(!info.isSymbolicLink(), "Bundle contains a symlink");
    const path = relative(root, full).replaceAll(sep, "/");
    assert.ok(ENTRY.test(path) && !PRIVATE.test("/" + path), "Unsafe bundle entry");
    if (info.isDirectory()) {
      files.push(...(await walk(full, root)));
    } else {
      assert.ok(info.isFile(), "Bundle contains a non-regular file");
      files.push(path);
    }
  }
  return files;
}

async function main() {
  const [rawDirectory, expectedSha] = process.argv.slice(2);
  assert.equal(process.argv.length, 4, "Usage: verify-windows-candidate.mjs <dir> <trusted-commit-sha>");
  assert.ok(SHA.test(expectedSha ?? ""), "Expected git SHA must be an independently verified commit");
  const directory = resolve(rawDirectory);
  const root = await lstat(directory);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), "Bundle root must be a directory");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "pokemon-beyond-preinstall-windows-v1");
  assert.equal(manifest.gitSha, expectedSha);
  assert.equal(manifest.result, "NO_GO_INSPECTION_ONLY");
  assert.equal(manifest.requiresOwnerApproval, true);
  assert.equal(manifest.productionDatabaseTouched, false);
  assert.equal(manifest.v4MigrationActive, false);
  assert.equal(manifest.dependenciesIncluded, false);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  const listed = new Set();
  for (const entry of manifest.files) {
    assert.ok(
      typeof entry.path === "string" &&
        ENTRY.test(entry.path) &&
        !PRIVATE.test("/" + entry.path) &&
        !entry.path.includes("//") &&
        !entry.path.split("/").includes("..") &&
        !isAbsolute(entry.path),
      "Manifest contains unsafe path",
    );
    assert.ok(!listed.has(entry.path), "Duplicate bundle entry");
    listed.add(entry.path);
    assert.ok(DIGEST.test(entry.sha256), "Invalid file digest");
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    const data = await readFile(join(directory, entry.path));
    assert.equal(data.byteLength, entry.bytes, "File size mismatch");
    assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256);
  }
  const diskFiles = await walk(directory, directory);
  const expected = [...listed, "manifest.json"].sort();
  assert.deepEqual(diskFiles.sort(), expected, "Unknown, missing or unlisted files in bundle");
  for (const required of [
    "dist/src/main.js",
    "pnpm-lock.yaml",
    "package.json",
    "READ_ME_FIRST.txt",
    "scripts/operations/release-local-readonly-preflight.ps1",
    "scripts/operations/verify-windows-candidate.mjs",
    "db/migrations/0079_stage2_move_acquisition_methods.sql",
  ]) {
    assert.ok(listed.has(required), "Missing essential bundle file");
  }
  const readme = await readFile(join(directory, "READ_ME_FIRST.txt"), "utf8");
  assert.ok(readme.includes("NO-GO"), "Bundle lost its installation prohibition");
  console.log("Windows candidate file integrity: PASS. NOT release approval or artifact authenticity.");
}

main().catch((error) => {
  console.error("Windows candidate verification failed:", error?.message ?? "unknown error");
  process.exitCode = 1;
});
