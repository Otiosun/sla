import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  PendingOutboxMessage,
} from "../../src/modules/messaging/contracts.js";
import type {
  MessagingService,
  OutboxWorker,
} from "../../src/modules/messaging/service.js";
import type {
  WhatsAppAdapter,
  WhatsAppIncomingHandler,
} from "../../src/adapters/whatsapp/adapter.js";
import { WhatsAppMessagingRuntime } from "../../src/adapters/whatsapp/runtime.js";

class FakeWhatsAppAdapter implements WhatsAppAdapter {
  public readonly channel = "whatsapp" as const;
  private incoming: WhatsAppIncomingHandler | null = null;

  public async start(onIncoming: WhatsAppIncomingHandler): Promise<void> {
    this.incoming = onIncoming;
  }

  public async stop(): Promise<void> {
    this.incoming = null;
  }

  public async send(_message: PendingOutboxMessage): Promise<{ providerExternalMessageId: null }> {
    return { providerExternalMessageId: null };
  }

  public async emit(message: IncomingMessage): Promise<void> {
    const incoming = this.incoming;
    if (incoming === null) throw new Error("Fake WhatsApp adapter is not started");
    await incoming(message);
  }
}

function incoming(text: string): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `runtime-prefix-${text}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: "120363000000000001@g.us",
    occurredAt: "2026-09-07T05:15:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  };
}

function runtimeFixture() {
  const adapter = new FakeWhatsAppAdapter();
  const receive = vi.fn(async () => undefined);
  const admitCommand = vi.fn(async () => true);
  const admitFreeform = vi.fn(async () => false);
  const runtime = new WhatsAppMessagingRuntime(
    adapter,
    { receive } as unknown as MessagingService,
    { runOnce: vi.fn() } as unknown as OutboxWorker,
    { admitCommand, admitFreeform },
  );
  return { adapter, receive, admitCommand, admitFreeform, runtime };
}

describe("WhatsApp runtime command prefixes", () => {
  it("admits slash-prefixed commands through the command gate", async () => {
    const fixture = runtimeFixture();
    const message = incoming("/pokemart");
    await fixture.runtime.start();

    await fixture.adapter.emit(message);

    expect(fixture.admitCommand).toHaveBeenCalledOnce();
    expect(fixture.admitCommand).toHaveBeenCalledWith(message);
    expect(fixture.admitFreeform).not.toHaveBeenCalled();
    expect(fixture.receive).toHaveBeenCalledOnce();
    expect(fixture.receive).toHaveBeenCalledWith(message);
  });

  it("preserves dollar-prefixed command admission", async () => {
    const fixture = runtimeFixture();
    const message = incoming("$pokemart");
    await fixture.runtime.start();

    await fixture.adapter.emit(message);

    expect(fixture.admitCommand).toHaveBeenCalledOnce();
    expect(fixture.admitFreeform).not.toHaveBeenCalled();
    expect(fixture.receive).toHaveBeenCalledOnce();
    expect(fixture.receive).toHaveBeenCalledWith(message);
  });
});
