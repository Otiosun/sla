import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const current = dirname(fileURLToPath(import.meta.url));
const script = join(current, "../../scripts/operations/backup-envelope.mjs");

function run(mode, input, output, key, allowRestore = false) {
  return spawnSync(process.execPath, [script, mode, input, output], {
    env: {
      ...process.env,
      BACKUP_ENCRYPTION_KEY_B64: key,
      ALLOW_DISPOSABLE_BACKUP_RESTORE: allowRestore ? "1" : "0",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("offline envelope encrypts and authenticates without exposing backup keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beyond-backup-envelope-"));
  try {
    const input = join(dir, "synthetic.dump");
    const output = join(dir, "encrypted.pbv4");
    const restore = join(dir, "restored.dump");
    const plain = Buffer.concat([
      Buffer.from("synthetic PG18 backup, no real users or sessions"),
      randomBytes(1024 * 64),
    ]);
    await writeFile(input, plain);
    const key = randomBytes(32).toString("base64");
    const otherKey = randomBytes(32).toString("base64");

    const encrypted = run("encrypt", input, output, key);
    assert.equal(encrypted.status, 0, encrypted.stderr);
    const vault = await readFile(output);
    assert.equal(vault.subarray(0, 8).toString("ascii"), "PBV4GCM1");
    assert.equal(vault.length, plain.length + 44);
    assert.equal(vault.includes(plain.subarray(0, 20)), false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);

    const denied = run("decrypt", output, restore, key);
    assert.notEqual(denied.status, 0);
    await assert.rejects(stat(restore));

    const wrong = run("decrypt", output, restore, otherKey, true);
    assert.notEqual(wrong.status, 0);
    await assert.rejects(stat(restore));

    const decoded = run("decrypt", output, restore, key, true);
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.deepEqual(await readFile(restore), plain);
    assert.equal((await stat(restore)).mode & 0o777, 0o600);

    const overwrite = run("decrypt", output, restore, key, true);
    assert.notEqual(overwrite.status, 0);
    assert.deepEqual(await readFile(restore), plain);

    const corrupted = Buffer.from(vault);
    corrupted[50] ^= 0x40;
    const altered = join(dir, "tampered.pbv4");
    await writeFile(altered, corrupted);
    const rejected = run("decrypt", altered, join(dir, "tampered.dump"), key, true);
    assert.notEqual(rejected.status, 0);
    await assert.rejects(stat(join(dir, "tampered.dump")));

    const second = join(dir, "second.pbv4");
    assert.equal(run("encrypt", input, second, key).status, 0);
    assert.notDeepEqual(await readFile(second), vault);
    assert.equal(encrypted.stdout.includes(key), false);
    assert.equal(encrypted.stderr.includes(key), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
