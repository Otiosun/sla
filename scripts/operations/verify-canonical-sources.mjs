import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const directory = new URL("../../docs/ux/canonical/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("sources.json", directory), "utf8"));
assert.equal(manifest.documents.length, 8);
assert.equal(manifest.sources.length, 27);
for (const entry of [...manifest.documents, ...manifest.sources]) {
  assert.ok(!entry.file.includes("..") && !entry.file.startsWith("/"));
  const bytes = await readFile(new URL(entry.file, directory));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.file);
  if (entry.blob) {
    assert.equal(entry.available, true, "Missing original: " + entry.file);
    const header = Buffer.from("blob " + bytes.length + "\0");
    assert.equal(
      createHash("sha1").update(header).update(bytes).digest("hex"),
      entry.blob,
      entry.file,
    );
  }
}
console.log("Canonical sources: 8 Drive snapshots and 27 original Git blobs verified.");
