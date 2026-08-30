import type { BaileysWaWebVersion } from "./baileys-provider-contracts.js";
import { fetchLatestWaWebVersion } from "./baileys-runtime.js";

interface BaileysWaWebVersionResult {
  readonly version: readonly number[];
  readonly isLatest: boolean;
}

export type BaileysWaWebVersionFetcher = () => Promise<BaileysWaWebVersionResult>;

export class WhatsAppWebVersionResolutionError extends Error {
  override readonly name = "WhatsAppWebVersionResolutionError";
}

function isValidVersionPart(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function resolveLatestWhatsAppWebVersion(
  fetchVersion: BaileysWaWebVersionFetcher = fetchLatestWaWebVersion,
): Promise<BaileysWaWebVersion> {
  let result: BaileysWaWebVersionResult;
  try {
    result = await fetchVersion();
  } catch {
    throw new WhatsAppWebVersionResolutionError("WhatsApp Web version resolution failed");
  }

  const [major, minor, patch] = result.version;
  if (
    result.isLatest !== true ||
    !Array.isArray(result.version) ||
    result.version.length !== 3 ||
    !isValidVersionPart(major) ||
    !isValidVersionPart(minor) ||
    !isValidVersionPart(patch)
  ) {
    throw new WhatsAppWebVersionResolutionError(
      "WhatsApp Web version resolution did not return a current valid protocol tuple",
    );
  }

  return [major, minor, patch];
}
