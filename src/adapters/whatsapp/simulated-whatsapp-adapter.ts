import type { ReceptionMembershipEvent } from "../../modules/community/reception-membership.js";
import {
  type IncomingMessage,
  IncomingMessageSchema,
  type MediaReference,
  type PendingOutboxMessage,
} from "../../modules/messaging/contracts.js";
import type { OutboundMessageReceipt } from "../../modules/messaging/ports.js";
import type {
  WhatsAppAdapter,
  WhatsAppIncomingHandler,
  WhatsAppProviderConnectionState,
} from "./adapter.js";

export type SimulatedWhatsAppTranscriptEntry =
  | {
      readonly sequence: number;
      readonly direction: "INBOUND";
      readonly message: IncomingMessage;
    }
  | {
      readonly sequence: number;
      readonly direction: "OUTBOUND";
      readonly message: PendingOutboxMessage;
      readonly providerExternalMessageId: string;
    }
  | {
      readonly sequence: number;
      readonly direction: "SYSTEM";
      readonly event:
        | "CONNECTED"
        | "DISCONNECTED"
        | "DELIVERY_FAILURE"
        | "MEMBERSHIP_ADD"
        | "MEMBERSHIP_REMOVE";
      readonly detail: string | null;
    };

export interface SimulatedIncomingTextInput {
  readonly senderRef: string;
  readonly chatRef: string;
  readonly text: string | null;
  readonly externalMessageId?: string;
  readonly occurredAt?: string;
  readonly mentions?: readonly string[];
  readonly mediaRefs?: readonly MediaReference[];
  readonly replyToExternalMessageId?: string | null;
}

export interface SimulatedMembershipInput {
  readonly chatRef: string;
  readonly externalId: string;
  readonly action: "add" | "remove";
}

export interface SimulatedWhatsAppAdapterOptions {
  readonly now?: () => Date;
  readonly providerMessageIdFor?: (message: PendingOutboxMessage) => string;
  readonly onMembership?: (event: ReceptionMembershipEvent) => Promise<void>;
  readonly onConnectionState?: (
    state: WhatsAppProviderConnectionState,
  ) => Promise<void> | void;
}

export class SimulatedWhatsAppAdapter implements WhatsAppAdapter {
  public readonly channel = "whatsapp" as const;
  public readonly sent: PendingOutboxMessage[] = [];
  public readonly transcript: SimulatedWhatsAppTranscriptEntry[] = [];

  private incomingHandler: WhatsAppIncomingHandler | null = null;
  private started = false;
  private connected = false;
  private failuresRemaining = 0;
  private incomingSequence = 0;
  private transcriptSequence = 0;

  public constructor(private readonly options: SimulatedWhatsAppAdapterOptions = {}) {}

  public async start(onIncoming: WhatsAppIncomingHandler): Promise<void> {
    if (this.started) {
      throw new Error("Simulated WhatsApp adapter is already started");
    }
    this.incomingHandler = onIncoming;
    this.started = true;
    await this.setConnectedInternal(true);
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    await this.setConnectedInternal(false);
    this.incomingHandler = null;
    this.started = false;
  }

  public async setConnected(connected: boolean): Promise<void> {
    if (!this.started) {
      throw new Error("Simulated WhatsApp adapter is not started");
    }
    await this.setConnectedInternal(connected);
  }

  public failNext(count = 1): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("Simulated WhatsApp failure count must be a non-negative integer");
    }
    this.failuresRemaining += count;
  }

  public async injectText(input: SimulatedIncomingTextInput): Promise<IncomingMessage> {
    this.incomingSequence += 1;
    const externalMessageId =
      input.externalMessageId ?? `SIM-IN-${this.incomingSequence.toString().padStart(6, "0")}`;
    const occurredAt = input.occurredAt ?? (this.options.now?.() ?? new Date()).toISOString();

    const message: IncomingMessage = IncomingMessageSchema.parse({
      provider: "baileys",
      externalMessageId,
      senderRef: input.senderRef,
      chatRef: input.chatRef,
      occurredAt,
      text: input.text,
      ...(input.mentions === undefined ? {} : { mentions: [...input.mentions] }),
      mediaRefs: [...(input.mediaRefs ?? [])],
      replyToExternalMessageId: input.replyToExternalMessageId ?? null,
    });
    await this.inject(message);
    return message;
  }

  public async inject(message: IncomingMessage): Promise<void> {
    this.assertReady();
    const parsed = IncomingMessageSchema.parse(message);
    if (parsed.provider !== "baileys") {
      throw new Error("Operational WhatsApp simulation requires provider baileys");
    }

    const handler = this.incomingHandler;
    if (handler === null) {
      throw new Error("Simulated WhatsApp adapter is not started");
    }

    this.transcript.push({
      sequence: this.nextTranscriptSequence(),
      direction: "INBOUND",
      message: parsed,
    });
    await handler(parsed);
  }

  public async injectMembership(input: SimulatedMembershipInput): Promise<void> {
    this.assertReady();
    const event: ReceptionMembershipEvent = {
      provider: "baileys",
      chatRef: input.chatRef,
      externalId: input.externalId,
      action: input.action,
    };
    this.transcript.push({
      sequence: this.nextTranscriptSequence(),
      direction: "SYSTEM",
      event: input.action === "add" ? "MEMBERSHIP_ADD" : "MEMBERSHIP_REMOVE",
      detail: `${input.externalId}@${input.chatRef}`,
    });
    await this.options.onMembership?.(event);
  }

  public async send(message: PendingOutboxMessage): Promise<OutboundMessageReceipt> {
    this.assertReady();
    if (message.channel !== "whatsapp") {
      throw new Error(`Simulated WhatsApp adapter cannot send channel ${message.channel}`);
    }

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      this.transcript.push({
        sequence: this.nextTranscriptSequence(),
        direction: "SYSTEM",
        event: "DELIVERY_FAILURE",
        detail: message.id,
      });
      throw new Error("Simulated WhatsApp delivery failure");
    }

    const providerExternalMessageId =
      this.options.providerMessageIdFor?.(message) ?? `SIM-OUT-${message.id}`;
    this.sent.push(message);
    this.transcript.push({
      sequence: this.nextTranscriptSequence(),
      direction: "OUTBOUND",
      message,
      providerExternalMessageId,
    });
    return { providerExternalMessageId };
  }

  private assertReady(): void {
    if (!this.started || this.incomingHandler === null) {
      throw new Error("Simulated WhatsApp adapter is not started");
    }
    if (!this.connected) {
      throw new Error("Simulated WhatsApp adapter is disconnected");
    }
  }

  private async setConnectedInternal(connected: boolean): Promise<void> {
    if (this.connected === connected) return;
    this.connected = connected;
    this.transcript.push({
      sequence: this.nextTranscriptSequence(),
      direction: "SYSTEM",
      event: connected ? "CONNECTED" : "DISCONNECTED",
      detail: null,
    });
    await this.options.onConnectionState?.(connected ? "CONNECTED" : "DISCONNECTED");
  }

  private nextTranscriptSequence(): number {
    this.transcriptSequence += 1;
    return this.transcriptSequence;
  }
}
