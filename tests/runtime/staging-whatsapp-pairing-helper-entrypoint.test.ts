import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("staging WhatsApp pairing helper entrypoint", () => {
  it("exposes one explicit pnpm command backed by an operations-only terminal adapter", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["ops:bootstrap:whatsapp:staging"]).toBe(
      "tsx scripts/operations/staging-whatsapp-pairing-helper.ts",
    );

    const source = await readFile("scripts/operations/staging-whatsapp-pairing-helper.ts", "utf8");
    expect(source).toContain("runStagingWhatsAppPairingHelperCli");
    expect(source).toContain("readHiddenTerminalInput");
    expect(source).toContain("process.stdin");
    expect(source).toContain("process.stdout.write");
    expect(source).not.toContain("WHATSAPP_AUTH_KEY_BASE64=");
    expect(source).not.toContain("DATABASE_URL=");
    expect(source).not.toContain("pokemon_migrator");
  });
});
