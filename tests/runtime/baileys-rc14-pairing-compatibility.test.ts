import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const EXPECTED_MARKER = "rc14-companion-reg-refresh-v1";

interface BaileysPackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly pokemonRpgPairingCompatibility?: unknown;
}

interface PairingQrRenderer {
  next(): boolean;
  refresh(): boolean;
}

interface CompanionRegModule {
  readonly makePairingQRRenderer?: (
    refs: string[],
    render: (ref: string) => void,
  ) => PairingQrRenderer;
  readonly handleCompanionRegRefresh?: (
    node: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, unknown>>,
  ) => string;
}

async function resolveBaileysPackageRoot(): Promise<string> {
  let directory = path.dirname(require.resolve("@whiskeysockets/baileys"));

  while (true) {
    try {
      const metadata = JSON.parse(
        await fs.readFile(path.join(directory, "package.json"), "utf8"),
      ) as BaileysPackageMetadata;
      if (metadata.name === "@whiskeysockets/baileys") return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Unable to resolve Baileys package root");
    directory = parent;
  }
}

async function readPackageMetadata(root: string): Promise<BaileysPackageMetadata> {
  return JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ) as BaileysPackageMetadata;
}

async function loadCompanionRegModule(): Promise<CompanionRegModule> {
  const root = await resolveBaileysPackageRoot();
  return (await import(
    pathToFileURL(path.join(root, "lib/Utils/companion-reg-client-utils.js")).href
  )) as CompanionRegModule;
}

function refreshContext(creds: Record<string, unknown>) {
  return {
    creds,
    emitCredsUpdate: vi.fn(),
    refreshQR: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe("audited Baileys rc14 first-pairing compatibility patch", () => {
  it("marks only the vendored rc14 patch as pairing compatible", async () => {
    const root = await resolveBaileysPackageRoot();
    const metadata = await readPackageMetadata(root);

    expect(metadata.version).toBe("7.0.0-rc14");
    expect(metadata.pokemonRpgPairingCompatibility).toBe(EXPECTED_MARKER);
  });

  it("keeps pre-login notification ACK generation null-safe in the installed compiled artifact", async () => {
    const root = await resolveBaileysPackageRoot();
    const source = await fs.readFile(path.join(root, "lib/Socket/messages-recv.js"), "utf8");

    expect(source).toContain("buildAckStanza(node, errorCode, authState.creds.me?.id)");
    expect(source).not.toContain("buildAckStanza(node, errorCode, authState.creds.me.id)");
  });

  it("re-renders the current QR ref without consuming another server ref", async () => {
    const module = await loadCompanionRegModule();

    expect(module.makePairingQRRenderer).toBeTypeOf("function");
    const renders: string[] = [];
    const renderer = module.makePairingQRRenderer?.(["ref-1", "ref-2"], (ref) => renders.push(ref));

    expect(renderer?.next()).toBe(true);
    expect(renderer?.refresh()).toBe(true);
    expect(renderer?.next()).toBe(true);
    expect(renderer?.next()).toBe(false);
    expect(renders).toEqual(["ref-1", "ref-1", "ref-2"]);
  });

  it("rotates the unpaired adv secret, emits the credential delta, and requests QR refresh", async () => {
    const module = await loadCompanionRegModule();
    expect(module.handleCompanionRegRefresh).toBeTypeOf("function");

    const creds: Record<string, unknown> = { advSecretKey: "old-secret" };
    const context = refreshContext(creds);
    const node = {
      tag: "notification",
      attrs: { id: "refresh-1", type: "companion_reg_refresh" },
      content: [{ tag: "companion_reg_refresh", attrs: {} }],
    };

    const outcome = module.handleCompanionRegRefresh?.(node, context);

    expect(outcome).toBe("rotated");
    expect(creds.advSecretKey).toEqual(expect.any(String));
    expect(creds.advSecretKey).not.toBe("old-secret");
    expect(Buffer.from(String(creds.advSecretKey), "base64")).toHaveLength(32);
    expect(context.emitCredsUpdate).toHaveBeenCalledWith({ advSecretKey: creds.advSecretKey });
    expect(context.refreshQR).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed companion refresh notifications without mutating pairing state", async () => {
    const module = await loadCompanionRegModule();
    const creds: Record<string, unknown> = { advSecretKey: "stable-secret" };
    const context = refreshContext(creds);
    const node = {
      tag: "notification",
      attrs: { id: "malformed-1", type: "companion_reg_refresh" },
      content: [],
    };

    const outcome = module.handleCompanionRegRefresh?.(node, context);

    expect(outcome).toBe("ignored_malformed");
    expect(creds.advSecretKey).toBe("stable-secret");
    expect(context.emitCredsUpdate).not.toHaveBeenCalled();
    expect(context.refreshQR).not.toHaveBeenCalled();
    expect(context.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("never rotates the adv secret after the session already has a registered identity", async () => {
    const module = await loadCompanionRegModule();
    const creds: Record<string, unknown> = {
      advSecretKey: "registered-secret",
      me: { id: "paired-user" },
    };
    const context = refreshContext(creds);
    const node = {
      tag: "notification",
      attrs: { id: "registered-1", type: "companion_reg_refresh" },
      content: [{ tag: "pair-device-rotate-qr", attrs: {} }],
    };

    const outcome = module.handleCompanionRegRefresh?.(node, context);

    expect(outcome).toBe("ignored_registered");
    expect(creds.advSecretKey).toBe("registered-secret");
    expect(context.emitCredsUpdate).not.toHaveBeenCalled();
    expect(context.refreshQR).not.toHaveBeenCalled();
    expect(context.logger.debug).toHaveBeenCalledTimes(1);
  });
});
