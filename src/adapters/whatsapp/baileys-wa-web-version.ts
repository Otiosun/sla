import type { BaileysWaWebVersion } from "./baileys-provider-contracts.js";
import { fetchLatestWaWebVersionResult } from "./baileys-runtime.js";

export interface WhatsAppWebVersionFetchResult {
  readonly version: readonly number[];
  readonly isLatest: boolean;
  readonly error?: unknown;
}

export type WhatsAppWebVersionFetcher = () => Promise<WhatsAppWebVersionFetchResult>;

export class WhatsAppWebVersionResolutionError extends Error {
  override readonly name = "WhatsAppWebVersionResolutionError";
}

function isValidVersionPart(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asWaWebVersion(value: readonly number[]): BaileysWaWebVersion | null {
  if (value.length !== 3) return null;
  const [major, minor, revision] = value;
  if (!isValidVersionPart(major) || !isValidVersionPart(minor) || !isValidVersionPart(revision)) {
    return null;
  }
  return [major, minor, revision];
}

export async function resolveLatestWhatsAppWebVersion(
  fetchVersion: WhatsAppWebVersionFetcher = fetchLatestWaWebVersionResult,
): Promise<BaileysWaWebVersion> {
  let result: WhatsAppWebVersionFetchResult;
  try {
    result = await fetchVersion();
  } catch {
    throw new WhatsAppWebVersionResolutionError(
      "Unable to resolve the current WhatsApp Web protocol version",
    );
  }

  const version = asWaWebVersion(result.version);
  if (result.isLatest !== true || version === null) {
    throw new WhatsAppWebVersionResolutionError(
      "WhatsApp Web protocol version is not confirmed current and valid",
    );
  }

  return version;
}
