import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const projectRequire = createRequire(import.meta.url);
const baileysEntry = projectRequire.resolve("@whiskeysockets/baileys");
// Resolve through Baileys so this assertion covers the exact transitive libsignal used at runtime.
const baileysRequire = createRequire(baileysEntry);

function installedLibsignalSource(path: string): string {
  return readFileSync(baileysRequire.resolve(`libsignal/${path}`), "utf8");
}

describe("libsignal sensitive logging boundary", () => {
  it("does not print Signal session lifecycle objects to stdout/stderr", () => {
    const sessionBuilder = installedLibsignalSource("src/session_builder.js");
    const sessionRecord = installedLibsignalSource("src/session_record.js");

    expect(sessionBuilder).not.toContain(
      'console.warn("Closing open session in favor of incoming prekey bundle")',
    );
    expect(sessionBuilder).not.toContain(
      'console.warn("Closing stale open session for new outgoing prekey bundle")',
    );
    expect(sessionRecord).not.toContain('console.warn("Session already closed", session)');
    expect(sessionRecord).not.toContain('console.info("Closing session:", session)');
    expect(sessionRecord).not.toContain('console.info("Opening session:", session)');
    expect(sessionRecord).not.toContain(
      'console.info("Removing old closed session:", oldestSession)',
    );
  });
});
