import { createHash } from "node:crypto";
import type { ReceptionMembershipEvent } from "../../modules/community/reception-membership.js";
import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboundMessageReceipt } from "../../modules/messaging/ports.js";
import { type MetricSink, monotonicNowMs, NOOP_METRICS } from "../../platform/metrics/index.js";
import type {
  WhatsAppAdapter,
  WhatsAppIncomingHandler,
  WhatsAppProviderConnectionState,
} from "./adapter.js";
import { normalizeBaileysMessage } from "./baileys-normalizer.js";
import type {
  BaileysConnectionUpdateLike,
  BaileysEventSourceLike,
  BaileysLoggerLike,
  BaileysMessagesUpsertLike,
  BaileysOutboundContentLike,
  BaileysQuotedMessageLike,
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

export type BaileysInboundDropReason =
  | "FROM_ME"
  | "HISTORY_REQUEST"
  | "NON_NOTIFY"
  | "UNSUPPORTED_OR_INVALID"
  | "MIXED"
  | null;

export interface BaileysInboundUpsertObservation {
  readonly acceptedCount: number;
  readonly droppedCount: number;
  readonly dropReason: BaileysInboundDropReason;
}

export interface BaileysWhatsAppAdapterOptions {
  readonly onMembership?: (event: ReceptionMembershipEvent) => Promise<void>;
  readonly auth: BaileysAuthBinding;
  readonly socketFactory?: BaileysSocketFactory;
  readonly reconnectDelayMs?: number;
  readonly logger?: BaileysLoggerLike;
  readonly metrics?: MetricSink;
  readonly onQr?: (qr: string) => Promise<void> | void;
  readonly onLoggedOut?: () => Promise<void> | void;
  readonly onConnectionState?: (state: WhatsAppProviderConnectionState) => Promise<void> | void;
  readonly onInboundUpsert?: (observation: BaileysInboundUpsertObservation) => Promise<void> | void;
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

interface BaileysParticipantIdentityLike {
  readonly id: string;
  readonly lid?: string | null;
  readonly phoneNumber?: string | null;
}

function canonicalDeviceId(id: string): string {
  return id.replace(/:\d+@/, "@");
}

function isPhoneNumberJid(id: string | null | undefined): id is string {
  return typeof id === "string" && /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(id);
}

function participantRefs(participant: BaileysParticipantIdentityLike): readonly string[] {
  return [
    ...new Set(
      [participant.id, participant.lid, participant.phoneNumber]
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .map(canonicalDeviceId),
    ),
  ];
}

function participantPhoneNumber(participant: BaileysParticipantIdentityLike): string | null {
  const candidate = [participant.phoneNumber, participant.id].find(isPhoneNumberJid);
  return candidate === undefined ? null : canonicalDeviceId(candidate);
}

function sameParticipant(
  left: BaileysParticipantIdentityLike,
  right: BaileysParticipantIdentityLike,
): boolean {
  const rightRefs = new Set(participantRefs(right));
  return participantRefs(left).some((ref) => rightRefs.has(ref));
}

function identityAliasesFromParticipants(
  participants: readonly BaileysParticipantIdentityLike[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();

  for (const participant of participants) {
    const phoneNumber = participantPhoneNumber(participant);
    if (phoneNumber === null) continue;

    for (const ref of participantRefs(participant)) {
      aliases.set(ref, phoneNumber);
    }
  }

  return aliases;
}

function textOutboundContent(message: PendingOutboxMessage): BaileysOutboundContentLike {
  const text = message.payload.text;
  if (typeof text !== "string" || text.length === 0 || text.length > 32_768) {
    throw new Error("Baileys TEXT outbound payload requires non-empty text up to 32768 chars");
  }

  const mentions = message.payload.mentions;
  if (mentions === undefined) return { text };
  if (
    !Array.isArray(mentions) ||
    mentions.length > 64 ||
    mentions.some((mention) => typeof mention !== "string" || mention.trim().length === 0)
  ) {
    throw new Error("Baileys TEXT outbound mentions must be an array of up to 64 non-empty JIDs");
  }
  return { text, mentions: mentions as readonly string[] };
}

function imageOutboundContent(message: PendingOutboxMessage): BaileysOutboundContentLike {
  const imageUrl = message.payload.imageUrl;
  if (typeof imageUrl !== "string" || imageUrl.trim().length === 0) {
    throw new Error("Baileys IMAGE outbound payload requires an HTTPS image URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl.trim());
  } catch {
    throw new Error("Baileys IMAGE outbound payload requires an HTTPS image URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    throw new Error("Baileys IMAGE outbound payload requires an HTTPS image URL");
  }

  const caption = message.payload.caption;
  const mentions = message.payload.mentions;
  if (
    mentions !== undefined &&
    (!Array.isArray(mentions) ||
      mentions.length > 64 ||
      mentions.some((mention) => typeof mention !== "string" || mention.trim().length === 0))
  ) {
    throw new Error("Baileys IMAGE outbound mentions must be up to 64 non-empty JIDs");
  }
  const image = {
    image: { url: imageUrl.trim() },
    ...(mentions === undefined ? {} : { mentions: mentions as string[] }),
  };
  if (caption === undefined) return image;
  if (typeof caption !== "string" || caption.length === 0 || caption.length > 32_768) {
    throw new Error("Baileys IMAGE outbound caption must be non-empty text up to 32768 chars");
  }
  return { ...image, caption };
}

function reactionOutboundContent(message: PendingOutboxMessage): BaileysOutboundContentLike {
  const emoji = message.payload.emoji;
  const targetExternalMessageId = message.payload.targetExternalMessageId;
  const targetSenderRef = message.payload.targetSenderRef;
  if (typeof emoji !== "string" || emoji.length === 0 || emoji.length > 16) {
    throw new Error("Baileys REACTION outbound payload requires a non-empty emoji");
  }
  if (typeof targetExternalMessageId !== "string" || targetExternalMessageId.trim().length === 0) {
    throw new Error("Baileys REACTION outbound payload requires targetExternalMessageId");
  }
  if (
    targetSenderRef !== undefined &&
    (typeof targetSenderRef !== "string" || targetSenderRef.trim().length === 0)
  ) {
    throw new Error("Baileys REACTION targetSenderRef must be a non-empty JID when provided");
  }

  return {
    react: {
      text: emoji,
      key: {
        remoteJid: message.destinationRef,
        id: targetExternalMessageId.trim(),
        ...(targetSenderRef === undefined ? {} : { participant: targetSenderRef.trim() }),
      },
    },
  };
}
function outboundContent(message: PendingOutboxMessage): BaileysOutboundContentLike {
  if (message.channel !== "whatsapp") {
    throw new Error(`Baileys adapter cannot send channel ${message.channel}`);
  }
  switch (message.messageType) {
    case "TEXT":
      return textOutboundContent(message);
    case "IMAGE":
      return imageOutboundContent(message);
    case "REACTION":
      return reactionOutboundContent(message);
    default:
      throw new Error(`Unsupported Baileys outbound message type: ${message.messageType}`);
  }
}

function quotedReply(message: PendingOutboxMessage): BaileysQuotedMessageLike | undefined {
  const externalMessageId = message.payload.replyToExternalMessageId;
  const senderRef = message.payload.replyToSenderRef;
  const replyText = message.payload.replyToText;
  if (
    typeof externalMessageId !== "string" ||
    externalMessageId.trim().length === 0 ||
    typeof replyText !== "string" ||
    replyText.trim().length === 0
  ) {
    return undefined;
  }
  if (
    senderRef !== undefined &&
    (typeof senderRef !== "string" || senderRef.trim().length === 0)
  ) {
    throw new Error("Baileys replyToSenderRef must be a non-empty JID when provided");
  }
  return {
    key: {
      remoteJid: message.destinationRef,
      id: externalMessageId.trim(),
      ...(typeof senderRef === "string" ? { participant: senderRef.trim() } : {}),
      fromMe: false,
    },
    message: { conversation: replyText },
  };
}

function providerExternalMessageId(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("key" in result)) return null;
  const key = result.key;
  if (typeof key !== "object" || key === null || !("id" in key)) return null;
  return typeof key.id === "string" && key.id.length > 0 ? key.id : null;
}

export function baileysOutboundMessageId(message: PendingOutboxMessage): string {
  const compactUuid = message.id.replaceAll("-", "").toUpperCase();
  if (/^[0-9A-F]{32}$/.test(compactUuid)) return compactUuid;

  return createHash("sha256")
    .update(`pokemon-rpg:baileys:${message.id}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
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
  private readonly onConnectionState:
    | ((state: WhatsAppProviderConnectionState) => Promise<void> | void)
    | undefined;
  private readonly onInboundUpsert:
    | ((observation: BaileysInboundUpsertObservation) => Promise<void> | void)
    | undefined;
  private readonly onProviderError: (error: unknown) => void;

  private socket: BaileysSocketLike | null = null;
  private incomingHandler: WhatsAppIncomingHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;
  private membershipQueue: Promise<void> = Promise.resolve();
  private readonly onMembership: BaileysWhatsAppAdapterOptions["onMembership"];

  constructor(options: BaileysWhatsAppAdapterOptions) {
    this.onMembership = options.onMembership;
    this.auth = options.auth;
    this.socketFactory = options.socketFactory ?? productionSocketFactory;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_500;
    this.logger = options.logger ?? silentLogger;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.onQr = options.onQr;
    this.onLoggedOut = options.onLoggedOut;
    this.onConnectionState = options.onConnectionState;
    this.onInboundUpsert = options.onInboundUpsert;
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
    await this.membershipQueue;
  }

  async send(message: PendingOutboxMessage): Promise<OutboundMessageReceipt> {
    const startedAtMs = monotonicNowMs();
    let result: "success" | "error" = "success";
    try {
      const socket = this.socket;
      if (socket === null || this.stopped) {
        throw new Error("Baileys WhatsApp adapter is not connected");
      }
      const messageId = baileysOutboundMessageId(message);
      const quoted = quotedReply(message);
      const sent = await socket.sendMessage(message.destinationRef, outboundContent(message), {
        messageId,
        ...(quoted === undefined ? {} : { quoted }),
      });
      const returnedMessageId = providerExternalMessageId(sent);
      if (returnedMessageId !== messageId) {
        throw new Error("Baileys provider did not preserve the deterministic outbound message id");
      }
      this.metrics.increment("whatsapp.outgoing.total");
      return { providerExternalMessageId: messageId };
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

    // A join request is not membership. Only provider-confirmed add/remove events
    // reach Reception; serialize them so a fast leave/rejoin cannot overtake a join.
    socket.ev.on("group-participants.update", (event) => {
      this.membershipQueue = this.membershipQueue
        .then(async () => {
          if (this.stopped || generation !== this.generation || this.onMembership === undefined)
            return;
          if (
            !/^\d+@g\.us$/.test(event.id) ||
            (event.action !== "add" && event.action !== "remove")
          )
            return;
          const members = event.action === "add" ? await socket.groupMetadata?.(event.id) : null;
          if (event.action === "add" && members === undefined)
            throw new Error("Reception requires confirmed group membership");
          for (const participant of event.participants) {
            if (this.stopped || generation !== this.generation) return;
            if (!/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(participant.id)) continue;

            const confirmedMember = members?.participants.find((member) =>
              sameParticipant(member, participant),
            );

            if (event.action === "add" && confirmedMember === undefined) continue;

            const externalId =
              participantPhoneNumber(participant) ??
              (confirmedMember === undefined ? null : participantPhoneNumber(confirmedMember)) ??
              canonicalDeviceId(participant.id);

            if (
              [socket.user?.id, socket.user?.lid].some(
                (id) => id !== undefined && canonicalDeviceId(id) === externalId,
              )
            )
              continue;

            await this.onMembership({
              provider: "baileys",
              chatRef: event.id,
              externalId,
              action: event.action,
            });
          }
        })
        .catch((error) => this.onProviderError(error));
    });

    socket.ev.on("creds.update", () => {
      void this.auth.saveCredentials().catch((error) => this.onProviderError(error));
    });
    socket.ev.on("messages.upsert", (event) => {
      void this.handleMessageUpsert(generation, socket, event).catch((error) => {
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
    socket: BaileysSocketLike,
    event: BaileysMessagesUpsertLike,
  ): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    let acceptedCount = 0;
    let droppedCount = 0;
    const dropReasons = new Set<Exclude<BaileysInboundDropReason, null | "MIXED">>();
    const dropped = (reason: Exclude<BaileysInboundDropReason, null | "MIXED">): void => {
      droppedCount += 1;
      dropReasons.add(reason);
    };

    try {
      if (event.type !== "notify") {
        for (const _message of event.messages) dropped("NON_NOTIFY");
        return;
      }
      if (event.requestId !== undefined) {
        for (const _message of event.messages) dropped("HISTORY_REQUEST");
        return;
      }

      const handler = this.incomingHandler;
      if (handler === null) return;

      for (const message of event.messages) {
        let normalized = normalizeBaileysMessage(message);
        if (normalized === null) {
          dropped(message.key.fromMe === true ? "FROM_ME" : "UNSUPPORTED_OR_INVALID");
          continue;
        }

        const needsAliasResolution =
          normalized.senderRef.endsWith("@lid") ||
          (normalized.mentions ?? []).some((mention) => mention.endsWith("@lid"));

        if (
          needsAliasResolution &&
          message.key.remoteJid?.endsWith("@g.us") &&
          socket.groupMetadata !== undefined
        ) {
          try {
            const metadata = await socket.groupMetadata(message.key.remoteJid);
            const aliases = identityAliasesFromParticipants(metadata.participants);
            normalized = normalizeBaileysMessage(message, aliases) ?? normalized;
          } catch (error) {
            this.onProviderError(error);
          }
        }

        this.metrics.increment("whatsapp.incoming.total");
        acceptedCount += 1;
        await handler(normalized);
      }
    } finally {
      const dropReason =
        dropReasons.size === 0
          ? null
          : dropReasons.size === 1
            ? ([...dropReasons][0] ?? null)
            : "MIXED";
      await this.onInboundUpsert?.({ acceptedCount, droppedCount, dropReason });
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
      await this.notifyConnectionState("CONNECTED");
      return;
    }
    if (update.connection !== "close") return;

    this.metrics.increment("whatsapp.connection.close_total");
    if (this.socket === socket) this.socket = null;
    await this.notifyConnectionState("DISCONNECTED");

    const statusCode = statusCodeFromError(update.lastDisconnect?.error);
    if (statusCode === loggedOutStatusCode) {
      this.metrics.increment("whatsapp.connection.logged_out_total");
      if (this.onLoggedOut) await this.onLoggedOut();
      return;
    }

    this.scheduleReconnect(generation);
  }

  private async notifyConnectionState(state: WhatsAppProviderConnectionState): Promise<void> {
    if (this.onConnectionState === undefined) return;
    try {
      await this.onConnectionState(state);
    } catch (error) {
      this.onProviderError(error);
    }
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
