import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import { type MetricSink, monotonicNowMs, NOOP_METRICS } from "../../platform/metrics/index.js";
import type { WhatsAppAdapter, WhatsAppIncomingHandler } from "./adapter.js";
import { normalizeBaileysMessage } from "./baileys-normalizer.js";
import type {
  BaileysConnectionUpdateLike,
  BaileysEventSourceLike,
  BaileysLoggerLike,
  BaileysMessagesUpsertLike,
  BaileysSocketConfigLike,
  BaileysSocketLike,
} from "./baileys-provider-contracts.js";
import { loggedOutStatusCode, makeSocket } from "./baileys-runtime.js";

export interface BaileysAuthBinding {
  readonly state: unknown;
  saveCredentials(): Promise<void>;
}

export type { BaileysEventSourceLike as BaileysEventSource, BaileysSocketLike };
export type BaileysSocketFactory = (config: BaileysSocketConfigLike) => BaileysSocketLike;

export interface BaileysWhatsAppAdapterOptions {
  readonly auth: BaileysAuthBinding;
  readonly socketFactory?: BaileysSocketFactory;
  readonly reconnectDelayMs?: number;
  readonly logger?: BaileysLoggerLike;
  readonly metrics?: MetricSink;
  readonly onQr?: (qr: string) => Promise<void> | void;
  readonly onLoggedOut?: () => Promise<void> | void;
  readonly onProviderError?: (error: unknown) => void;
}

const silentLogger: BaileysLoggerLike = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const productionSocketFactory: BaileysSocketFactory = (config) => makeSocket(config);

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

function textPayload(message: PendingOutboxMessage): string {
  if (message.channel !== "whatsapp") {
    throw new Error(`Baileys adapter cannot send channel ${message.channel}`);
  }
  if (message.messageType !== "TEXT") {
    throw new Error(`Unsupported Baileys outbound message type: ${message.messageType}`);
  }
  const text = message.payload.text;
  if (typeof text !== "string" || text.length === 0 || text.length > 32_768) {
    throw new Error("Baileys TEXT outbound payload requires non-empty text up to 32768 chars");
  }
  return text;
}

export class BaileysWhatsAppAdapter implements WhatsAppAdapter {
  readonly channel = "whatsapp" as const;

  private readonly auth: BaileysAuthBinding;
  private readonly socketFactory: BaileysSocketFactory;
  private readonly reconnectDelayMs: number;
  private readonly logger: BaileysLoggerLike;
  private readonly metrics: MetricSink;
  private readonly onQr: ((qr: string) => Promise<void> | void) | undefined;
  private readonly onLoggedOut: (() => Promise<void> | void) | undefined;
  private readonly onProviderError: (error: unknown) => void;

  private socket: BaileysSocketLike | null = null;
  private incomingHandler: WhatsAppIncomingHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;

  constructor(options: BaileysWhatsAppAdapterOptions) {
    this.auth = options.auth;
    this.socketFactory = options.socketFactory ?? productionSocketFactory;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_500;
    this.logger = options.logger ?? silentLogger;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.onQr = options.onQr;
    this.onLoggedOut = options.onLoggedOut;
    this.onProviderError = options.onProviderError ?? (() => {});

    if (!Number.isFinite(this.reconnectDelayMs) || this.reconnectDelayMs < 0) {
      throw new Error("Baileys reconnectDelayMs must be a non-negative finite number");
    }
  }

  async start(onIncoming: WhatsAppIncomingHandler): Promise<void> {
    if (this.incomingHandler !== null) {
      throw new Error("Baileys WhatsApp adapter is already started");
    }

    this.incomingHandler = onIncoming;
    this.stopped = false;
    try {
      this.connect();
    } catch (error) {
      this.stopped = true;
      this.incomingHandler = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.incomingHandler = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    socket?.end();
  }

  async send(message: PendingOutboxMessage): Promise<void> {
    const startedAtMs = monotonicNowMs();
    let result: "success" | "error" = "success";
    try {
      const socket = this.socket;
      if (socket === null || this.stopped) {
        throw new Error("Baileys WhatsApp adapter is not connected");
      }
      await socket.sendMessage(message.destinationRef, { text: textPayload(message) });
      this.metrics.increment("whatsapp.outgoing.total");
    } catch (error) {
      result = "error";
      this.metrics.increment("whatsapp.outgoing.errors_total");
      throw error;
    } finally {
      this.metrics.observe("whatsapp.outgoing.duration_ms", monotonicNowMs() - startedAtMs, {
        result,
      });
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const generation = ++this.generation;
    const socket = this.socketFactory({
      auth: this.auth.state,
      logger: this.logger,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
    });
    this.socket = socket;

    socket.ev.on("creds.update", () => {
      void this.auth.saveCredentials().catch((error) => this.onProviderError(error));
    });
    socket.ev.on("messages.upsert", (event) => {
      void this.handleMessageUpsert(generation, event).catch((error) => {
        this.metrics.increment("whatsapp.incoming.errors_total");
        this.onProviderError(error);
      });
    });
    socket.ev.on("connection.update", (update) => {
      void this.handleConnectionUpdate(generation, socket, update).catch((error) =>
        this.onProviderError(error),
      );
    });
  }

  private async handleMessageUpsert(
    generation: number,
    event: BaileysMessagesUpsertLike,
  ): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    if (event.type !== "notify" || event.requestId !== undefined) return;

    const handler = this.incomingHandler;
    if (handler === null) return;

    for (const message of event.messages) {
      const normalized = normalizeBaileysMessage(message);
      if (normalized !== null) {
        this.metrics.increment("whatsapp.incoming.total");
        await handler(normalized);
      }
    }
  }

  private async handleConnectionUpdate(
    generation: number,
    socket: BaileysSocketLike,
    update: BaileysConnectionUpdateLike,
  ): Promise<void> {
    if (this.stopped || generation !== this.generation) return;

    if (update.qr && this.onQr) {
      await this.onQr(update.qr);
    }

    if (update.connection === "open") {
      this.metrics.increment("whatsapp.connection.open_total");
      return;
    }
    if (update.connection !== "close") return;

    this.metrics.increment("whatsapp.connection.close_total");
    if (this.socket === socket) this.socket = null;

    const statusCode = statusCodeFromError(update.lastDisconnect?.error);
    if (statusCode === loggedOutStatusCode) {
      this.metrics.increment("whatsapp.connection.logged_out_total");
      if (this.onLoggedOut) await this.onLoggedOut();
      return;
    }

    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number): void {
    if (this.stopped || generation !== this.generation || this.reconnectTimer !== null) return;

    this.metrics.increment("whatsapp.reconnect.scheduled_total");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || generation !== this.generation) return;
      try {
        this.connect();
      } catch (error) {
        this.onProviderError(error);
        this.scheduleReconnect(this.generation);
      }
    }, this.reconnectDelayMs);
  }
}
