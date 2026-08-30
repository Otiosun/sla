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
  readonly pokemonRpgPairingCompatibility?: unknown;
}

async function readJson(filePath: string): Promise<PackageMetadata | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as PackageMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function findInstalledPackage(): Promise<PackageMetadata> {
  let directory = path.dirname(require.resolve("@whiskeysockets/baileys"));
  while (true) {
    const metadata = await readJson(path.join(directory, "package.json"));
    if (metadata?.name === "@whiskeysockets/baileys") return metadata;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new WhatsAppPairingPackageVersionResolutionError(
    "Unable to resolve the installed Baileys package metadata",
  );
}

export async function resolveInstalledBaileysIdentity(): Promise<InstalledBaileysIdentity> {
  const metadata = await findInstalledPackage();
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new WhatsAppPairingPackageVersionResolutionError(
      "Installed Baileys package metadata has no valid version",
    );
  }
  const marker = metadata.pokemonRpgPairingCompatibility;
  return {
    version: metadata.version,
    pairingCompatibility: typeof marker === "string" && marker.length > 0 ? marker : null,
  };
}

export async function resolveInstalledBaileysVersion(): Promise<string> {
  return (await resolveInstalledBaileysIdentity()).version;
}
