import { createInitialAuthCreds } from "../adapters/whatsapp/baileys-runtime.js";
import type { BaileysSocketFactory } from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { BaileysConnectionUpdateLike } from "../adapters/whatsapp/baileys-provider-contracts.js";
import type {
  BaileysAuthSnapshot,
  PostgresBaileysAuthOptions,
  WhatsAppAuthBootstrapReservation,
} from "../adapters/whatsapp/postgres-baileys-auth.js";
import type { WhatsAppPairingBootstrapConfig } from "./whatsapp-pairing-bootstrap-config.js";

const KNOWN_BROKEN_PROVIDER_VERSIONS = new Set(["7.0.0-rc14"]);

type SignalKeyData = Readonly<
  Record<string, Readonly<Record<string, unknown | null | undefined>>>
>;

export interface SensitivePairingQrSink {
  render(qr: string): Promise<void> | void;
}

export type WhatsAppAuthBootstrapReservationFactory = (
  options: PostgresBaileysAuthOptions,
) => Promise<WhatsAppAuthBootstrapReservation>;

export interface WhatsAppPairingBootstrapDependencies {
  readonly config: WhatsAppPairingBootstrapConfig;
  readonly providerVersion: string;
  readonly reserveBootstrap: WhatsAppAuthBootstrapReservationFactory;
  readonly socketFactory: BaileysSocketFactory;
  readonly qrSink: SensitivePairingQrSink;
}

export class WhatsAppPairingProviderVersionBlockedError extends Error {
  override readonly name = "WhatsAppPairingProviderVersionBlockedError";
}

export class WhatsAppPairingProviderClosedError extends Error {
  override readonly name = "WhatsAppPairingProviderClosedError";
}

export class WhatsAppPairingIncompleteAuthError extends Error {
  override readonly name = "WhatsAppPairingIncompleteAuthError";
}

export class WhatsAppPairingTimeoutError extends Error {
  override readonly name = "WhatsAppPairingTimeoutError";
}

export class WhatsAppPairingQrSinkError extends Error {
  override readonly name = "WhatsAppPairingQrSinkError";
}

interface SilentLogger {
  readonly level: string;
  child(): SilentLogger;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

const silentLogger: SilentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

function recordObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WhatsAppPairingIncompleteAuthError("WhatsApp pairing credentials are invalid");
  }
  return value as Record<string, unknown>;
}

class EphemeralBaileysAuth {
  readonly creds: Record<string, unknown>;
  private readonly values = new Map<string, Map<string, unknown>>();

  readonly state: {
    readonly creds: Record<string, unknown>;
    readonly keys: {
      get(type: string, ids: readonly string[]): Promise<Record<string, unknown>>;
      set(data: SignalKeyData): Promise<void>;
    };
  };

  constructor() {
    this.creds = recordObject(createInitialAuthCreds());
    this.state = {
      creds: this.creds,
      keys: {
        get: (type, ids) => this.get(type, ids),
        set: (data) => this.set(data),
      },
    };
  }

  applyCredentialsUpdate(update: unknown): void {
    if (typeof update !== "object" || update === null || Array.isArray(update)) return;
    Object.assign(this.creds, update);
  }

  snapshot(): BaileysAuthSnapshot {
    const keys: Record<string, Record<string, unknown>> = {};
    for (const [type, entries] of this.values) {
      keys[type] = Object.fromEntries(entries);
    }
    return {
      creds: { ...this.creds },
      keys,
    };
  }

  private async get(type: string, ids: readonly string[]): Promise<Record<string, unknown>> {
    const entries = this.values.get(type);
    const output: Record<string, unknown> = {};
    if (entries === undefined) return output;
    for (const id of ids) {
      if (entries.has(id)) output[id] = entries.get(id);
    }
    return output;
  }

  private async set(data: SignalKeyData): Promise<void> {
    for (const [type, entries] of Object.entries(data)) {
      let values = this.values.get(type);
      if (values === undefined) {
        values = new Map();
        this.values.set(type, values);
      }
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) values.delete(id);
        else values.set(id, value);
      }
      if (values.size === 0) this.values.delete(type);
    }
  }
}

function assertCoreConfig(config: WhatsAppPairingBootstrapConfig): void {
  if (config.appEnv !== "staging" && config.appEnv !== "production") {
    throw new Error("WhatsApp first pairing requires a release environment");
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error("WhatsApp pairing timeout must be a positive safe integer");
  }
}

function assertProviderVersion(providerVersion: string): void {
  if (providerVersion.length === 0 || KNOWN_BROKEN_PROVIDER_VERSIONS.has(providerVersion)) {
    throw new WhatsAppPairingProviderVersionBlockedError(
      `WhatsApp first pairing is blocked for Baileys ${providerVersion || "unknown"}`,
    );
  }
}

function asConnectionUpdate(value: unknown): BaileysConnectionUpdateLike | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as BaileysConnectionUpdateLike;
}

function safeEnd(socket: { end(): void } | null): void {
  if (socket === null) return;
  try {
    socket.end();
  } catch {
    // Cleanup is best effort; the pairing result remains authoritative.
  }
}

async function executePairing(
  dependencies: WhatsAppPairingBootstrapDependencies,
  reservation: WhatsAppAuthBootstrapReservation,
): Promise<void> {
  const auth = new EphemeralBaileysAuth();
  let socket: ReturnType<BaileysSocketFactory> | null = null;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const clearDeadline = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      safeEnd(socket);
      reject(error);
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      safeEnd(socket);
      void (async () => {
        try {
          if (auth.creds.registered !== true) {
            throw new WhatsAppPairingIncompleteAuthError(
              "WhatsApp provider opened without registered pairing credentials",
            );
          }
          await reservation.commit(auth.snapshot());
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    };

    try {
      socket = dependencies.socketFactory({
        auth: auth.state,
        logger: silentLogger,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
        syncFullHistory: false,
      });
      socket.ev.on("creds.update", (update) => {
        auth.applyCredentialsUpdate(update);
      });
      socket.ev.on("connection.update", (value) => {
        const update = asConnectionUpdate(value);
        if (update === null) return;

        if (typeof update.qr === "string" && update.qr.length > 0) {
          void Promise.resolve(dependencies.qrSink.render(update.qr)).catch(() => {
            fail(new WhatsAppPairingQrSinkError("Sensitive WhatsApp QR rendering failed"));
          });
        }
        if (update.connection === "open") succeed();
        else if (update.connection === "close") {
          fail(new WhatsAppPairingProviderClosedError("WhatsApp provider closed before pairing"));
        }
      });
      timeout = setTimeout(() => {
        fail(new WhatsAppPairingTimeoutError("WhatsApp first pairing timed out"));
      }, dependencies.config.timeoutMs);
    } catch (error) {
      settled = true;
      clearDeadline();
      safeEnd(socket);
      reject(error);
    }
  });

  safeEnd(socket);
}

export async function runWhatsAppPairingBootstrap(
  dependencies: WhatsAppPairingBootstrapDependencies,
): Promise<void> {
  assertCoreConfig(dependencies.config);
  assertProviderVersion(dependencies.providerVersion);

  const reservation = await dependencies.reserveBootstrap({
    sessionKey: dependencies.config.sessionKey,
    encryptionKey: dependencies.config.authEncryptionKey,
    encryptionKeyVersion: dependencies.config.authEncryptionKeyVersion,
  });

  let failure: unknown;
  try {
    await executePairing(dependencies, reservation);
  } catch (error) {
    failure = error;
  }

  try {
    await reservation.close();
  } catch (error) {
    if (failure === undefined) failure = error;
  }

  if (failure !== undefined) throw failure;
}
