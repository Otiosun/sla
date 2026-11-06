import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, link, lstat, open, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("PBV4GCM1", "ascii");
const HEADER_BYTES = 28;
const TAG_BYTES = 16;

function requireKey() {
  const encoded = process.env.BACKUP_ENCRYPTION_KEY_B64 ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY_B64 must be a canonical base64-encoded 32-byte random key",
    );
  }
  return key;
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
    throw new Error("Input must be a non-empty regular file, never a symlink");
  }
  return info;
}

async function persistExclusive(temp, final) {
  // FlushFileBuffers on Windows requires a writable handle. Keep the sync
  // before publishing; silently ignoring EPERM would weaken backup durability.
  const file = await open(temp, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await link(temp, final);
}

async function encrypt(source, final, key, temp) {
  const input = await regularFile(source);
  if (!Number.isSafeInteger(input.size)) throw new Error("Input is too large");
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  const iv = randomBytes(12);
  iv.copy(header, 8);
  header.writeBigUInt64BE(BigInt(input.size), 20);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  await writeFile(temp, header, { flag: "wx", mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(temp, { flags: "a" }));
  await appendFile(temp, cipher.getAuthTag());
  const output = await stat(temp);
  const now = await stat(source);
  if (
    output.size !== HEADER_BYTES + input.size + TAG_BYTES ||
    now.size !== input.size ||
    now.mtimeMs !== input.mtimeMs
  ) {
    throw new Error("Encrypted length or source stability check failed");
  }
  await persistExclusive(temp, final);
}

async function decrypt(source, final, key, temp) {
  if (process.env.ALLOW_DISPOSABLE_BACKUP_RESTORE !== "1") {
    throw new Error(
      "Decrypt requires ALLOW_DISPOSABLE_BACKUP_RESTORE=1 in an isolated restore workspace",
    );
  }
  const info = await regularFile(source);
  if (info.size <= HEADER_BYTES + TAG_BYTES) throw new Error("Encrypted envelope is incomplete");
  const file = await open(source, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    const first = await file.read(header, 0, HEADER_BYTES, 0);
    const last = await file.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    if (
      first.bytesRead !== HEADER_BYTES ||
      last.bytesRead !== TAG_BYTES ||
      !header.subarray(0, 8).equals(MAGIC)
    ) {
      throw new Error("Invalid encrypted backup header");
    }
  } finally {
    await file.close();
  }
  const length = header.readBigUInt64BE(20);
  if (
    length > BigInt(Number.MAX_SAFE_INTEGER) ||
    length !== BigInt(info.size - HEADER_BYTES - TAG_BYTES)
  ) {
    throw new Error("Encrypted backup length is inconsistent");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(8, 20));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await writeFile(temp, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  await pipeline(
    createReadStream(source, { start: HEADER_BYTES, end: info.size - TAG_BYTES - 1 }),
    decipher,
    createWriteStream(temp, { flags: "a" }),
  );
  const output = await stat(temp);
  if (BigInt(output.size) !== length) throw new Error("Authenticated backup length mismatch");
  await persistExclusive(temp, final);
}

async function main() {
  const [operation, rawInput, rawOutput] = process.argv.slice(2);
  if (process.argv.length !== 5 || !["encrypt", "decrypt"].includes(operation ?? "")) {
    throw new Error(
      "Usage: backup-envelope.mjs encrypt|decrypt <input> <new-output>; never use production restore paths",
    );
  }
  const source = resolve(rawInput);
  const final = resolve(rawOutput);
  if (source === final) throw new Error("Input and output paths must differ");
  const key = requireKey();
  const temp = final + ".partial-" + randomBytes(8).toString("hex");
  try {
    if (operation === "encrypt") await encrypt(source, final, key, temp);
    else await decrypt(source, final, key, temp);
    console.log("Authenticated backup envelope validated and created");
  } finally {
    key.fill(0);
    await unlink(temp).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

main().catch((error) => {
  console.error("Backup envelope failed:", error?.message ?? "unknown error");
  process.exitCode = 1;
});
