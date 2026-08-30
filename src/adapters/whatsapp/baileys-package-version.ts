import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export interface InstalledBaileysIdentity {
  readonly version: string;
  readonly pairingCompatibility: string | null;
}

export class WhatsAppPairingPackageVersionResolutionError extends Error {
  override readonly name = "WhatsAppPairingPackageVersionResolutionError";
}

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
}

async function readJson(filePath: string): Promise<PackageMetadata | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as PackageMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveInstalledBaileysVersion(): Promise<string> {
  const entryPath = require.resolve("@whiskeysockets/baileys");
  let directory = path.dirname(entryPath);

  while (true) {
    const metadata = await readJson(path.join(directory, "package.json"));
    if (metadata?.name === "@whiskeysockets/baileys") {
      if (typeof metadata.version !== "string" || metadata.version.length === 0) {
        throw new WhatsAppPairingPackageVersionResolutionError(
          "Installed Baileys package metadata has no valid version",
        );
      }
      return metadata.version;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new WhatsAppPairingPackageVersionResolutionError(
    "Unable to resolve the installed Baileys package version",
  );
}
