import type { InstalledBaileysIdentity } from "../adapters/whatsapp/baileys-package-version.js";
import type { BaileysConnectionUpdateLike } from "../adapters/whatsapp/baileys-provider-contracts.js";
import { createInitialAuthCreds, pairingBrowser } from "../adapters/whatsapp/baileys-runtime.js";
import type { BaileysSocketFactory } from "../adapters/whatsapp/baileys-whatsapp-adapter.js";
import type {
  BaileysAuthSnapshot,
  PostgresBaileysAuthOptions,
  WhatsAppAuthBootstrapReservation,
} from "../adapters/whatsapp/postgres-baileys-auth.js";
import type { WhatsAppPairingBootstrapConfig } from "./whatsapp-pairing-bootstrap-config.js";

const AUDITED_RC14_PAIRING_COMPATIBILITY = "rc14-companion-reg-refresh-v1";
const MAX_PAIRING_RESTARTS = 1;

type SignalKeyData = Readonly<Record<string, Readonly<Record<string, unknown | null | undefined>>>>;

export interface SensitivePairingQrSink {
  render(qr: string): Promise<void> | void;
}

export interface SensitivePairingCodeSink {
  render(code: string): Promise<void> | void;
}

export type WhatsAppAuthBootstrapReservationFactory = (
  options: PostgresBaileysAuthOptions,
) => Promise<WhatsAppAuthBootstrapReservation>;

export interface WhatsAppPairingBootstrapDependencies {
  readonly config: WhatsAppPairingBootstrapConfig;
  readonly providerIdentity: InstalledBaileysIdentity;
  readonly reserveBootstrap: WhatsAppAuthBootstrapReservationFactory;
  readonly socketFactory: BaileysSocketFactory;
  readonly qrSink: SensitivePairingQrSink;
  readonly codeSink?: SensitivePairingCodeSink;
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

export class WhatsAppPairingCodeRequestError extends Error {
  override readonly name = "WhatsAppPairingCodeRequestError";
  readonly providerErrorName: string;
  readonly statusCode: number | null;

  constructor(cause: unknown, phone: string) {
    const providerErrorName = cause instanceof Error ? cause.name : "UnknownError";
    const statusCode = statusCodeFromError(cause);
    const providerMessage = safeProviderMessage(cause, phone);
    super(
      `WhatsApp pairing code request failed: ${providerErrorName}: ${providerMessage}${statusCode === null ? "" : ` (status ${statusCode})`}`,
      { cause },
    );
    this.providerErrorName = providerErrorName;
    this.statusCode = statusCode;
  }
}

export class WhatsAppPairingCodeConnectionError extends Error {
  override readonly name = "WhatsAppPairingCodeConnectionError";
  readonly statusCode: number | null;

  constructor(cause: unknown, phone: string) {
    const statusCode = statusCodeFromError(cause);
    super(
      `WhatsApp pairing code connection closed: ${safeProviderMessage(cause, phone)}${statusCode === null ? "" : ` (status ${statusCode})`}`,
      { cause },
    );
    this.statusCode = statusCode;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPairedAuthIdentity(creds: Readonly<Record<string, unknown>>): boolean {
  if (creds.registered === true) return true;

  const me = creds.me;
  const account = creds.account;
  const signalIdentities = creds.signalIdentities;
  return (
    isRecord(me) &&
    typeof me.id === "string" &&
    me.id.length > 0 &&
    isRecord(account) &&
    Array.isArray(signalIdentities) &&
    signalIdentities.length > 0
  );
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

  hasPairedIdentity(): boolean {
    return hasPairedAuthIdentity(this.creds);
  }

  pairedSnapshot(): BaileysAuthSnapshot {
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      creds: { ...snapshot.creds, registered: true },
    };
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
  if (config.pairingMode === "code" && config.pairingPhoneE164 == null) {
    throw new Error("WhatsApp pairing code mode requires an E.164 phone number");
  }
}

export function assertWhatsAppPairingProviderIdentitySupported(
  identity: InstalledBaileysIdentity,
): void {
  if (
    identity.version !== "7.0.0-rc14" ||
    identity.pairingCompatibility !== AUDITED_RC14_PAIRING_COMPATIBILITY
  ) {
    throw new WhatsAppPairingProviderVersionBlockedError(
      `WhatsApp first pairing is blocked for Baileys ${identity.version || "unknown"}`,
    );
  }
}

function asConnectionUpdate(value: unknown): BaileysConnectionUpdateLike | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as BaileysConnectionUpdateLike;
}

function statusCodeFromError(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;

  if ("output" in error) {
    const output = error.output;
    if (typeof output === "object" && output !== null && "statusCode" in output) {
      const statusCode = output.statusCode;
      if (typeof statusCode === "number") return statusCode;
    }
  }

  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  return null;
}

function safeProviderMessage(error: unknown, phone: string): string {
  const message = error instanceof Error ? error.message : "Provider rejected pairing code request";
  return message
    .replaceAll(phone, "[redacted]")
    .replace(/\b\d{6,15}\b/g, "[redacted]")
    .replace(/\b[A-Z0-9]{4}-?[A-Z0-9]{4}\b/gi, "[redacted]")
    .slice(0, 240);
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
    let restartCount = 0;
    let pairingCodeRequested = false;

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
          if (!auth.hasPairedIdentity()) {
            throw new WhatsAppPairingIncompleteAuthError(
              "WhatsApp provider opened without completed pairing credentials",
            );
          }
          await reservation.commit(auth.pairedSnapshot());
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    };

    const createSocket = (): void => {
      const currentSocket = dependencies.socketFactory({
        auth: auth.state,
        logger: silentLogger,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
        syncFullHistory: false,
        browser: pairingBrowser,
      });
      socket = currentSocket;

      currentSocket.ev.on("creds.update", (update) => {
        if (settled || socket !== currentSocket) return;
        auth.applyCredentialsUpdate(update);
      });
      currentSocket.ev.on("connection.update", (value) => {
        if (settled || socket !== currentSocket) return;
        const update = asConnectionUpdate(value);
        if (update === null) return;

        if (
          dependencies.config.pairingMode === "qr" &&
          typeof update.qr === "string" &&
          update.qr.length > 0
        ) {
          void Promise.resolve(dependencies.qrSink.render(update.qr)).catch(() => {
            fail(new WhatsAppPairingQrSinkError("Sensitive WhatsApp QR rendering failed"));
          });
        }
        if (update.connection === "open") {
          succeed();
          return;
        }
        if (update.connection !== "close") return;

        const statusCode = statusCodeFromError(update.lastDisconnect?.error);
        if (auth.hasPairedIdentity() && statusCode === 515 && restartCount < MAX_PAIRING_RESTARTS) {
          restartCount += 1;
          socket = null;
          safeEnd(currentSocket);
          try {
            createSocket();
          } catch (error) {
            fail(
              error instanceof Error
                ? error
                : new WhatsAppPairingProviderClosedError(
                    "WhatsApp provider restart failed during pairing",
                  ),
            );
          }
          return;
        }

        if (dependencies.config.pairingMode === "code") {
          fail(
            new WhatsAppPairingCodeConnectionError(
              update.lastDisconnect?.error,
              dependencies.config.pairingPhoneE164 ?? "",
            ),
          );
          return;
        }
        fail(new WhatsAppPairingProviderClosedError("WhatsApp provider closed before pairing"));
      });
      if (dependencies.config.pairingMode === "code" && !pairingCodeRequested) {
        pairingCodeRequested = true;
        const phone = dependencies.config.pairingPhoneE164;
        if (phone == null || currentSocket.requestPairingCode === undefined) {
          fail(new Error("WhatsApp pairing code mode requires an E.164 phone number"));
          return;
        }
        const requestPairingCode = currentSocket.requestPairingCode.bind(currentSocket);
        void requestPairingCode(phone)
          .then((code) => dependencies.codeSink?.render(code))
          .catch((error: unknown) => fail(new WhatsAppPairingCodeRequestError(error, phone)));
      }
    };

    try {
      createSocket();
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
  if (dependencies.config.pairingMode === "code" && dependencies.codeSink === undefined) {
    throw new Error("WhatsApp pairing code mode requires an interactive code sink");
  }
  assertWhatsAppPairingProviderIdentitySupported(dependencies.providerIdentity);

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
