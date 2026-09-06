import { describe, expect, it } from "vitest";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { RegistrationConversationResolver } from "../../src/modules/registration/conversation-resolver.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";

function context(
  text: string,
  replyToExternalMessageId: string | null = null,
): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000101",
    correlationId: "00000000-0000-4000-8000-000000000102",
    causationId: "00000000-0000-4000-8000-000000000101",
    idempotencyKey: "inbox:whatsapp:registration-freeform-intent",
    message: {
      provider: "whatsapp",
      externalMessageId: "registration-freeform-intent",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-06T01:05:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId,
    },
  };
}

function resolverFor(
  sessions: RegistrationConversationSessions,
  playerId: ReturnType<typeof createPlayerId>,
) {
  return new RegistrationConversationResolver({
    sessions,
    community: {
      resolveChat: async () => ({
        known: true,
        groupId: "00000000-0000-4000-8000-000000000201",
        role: "RECEPTION" as const,
        capabilities: ["onboarding" as const, "player.basic" as const],
      }),
    },
    players: {
      resolvePlayer: async () => ok({ playerId, state: "NEW" as const }),
    },
    setup: {
      load: async () =>
        ok({
          regionId: ZHOULIA_ID,
          regionDisplayName: "Zhoulia",
          starterOptions: [],
        }),
    },
  });
}

describe("registration freeform intent", () => {
  it("still accepts a compact mode choice without requiring a reply", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("2"));

    expect(routed).toMatchObject({
      ok: true,
      value: { resultRefType: "REGISTRATION_SESSION", resultRefId: playerId },
    });
    expect(sessions.get(playerId)).toMatchObject({ mode: "FULL", dirty: false });
  });

  it("ignores unrelated normal text while a full registration session is open", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "FULL", regionId: ZHOULIA_ID });
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("Tá, ótimo sinal"));

    expect(routed).toEqual({ ok: true, value: null });
    expect(sessions.get(playerId)).toMatchObject({ mode: "FULL", dirty: false });
  });

  it("ignores unrelated normal text while a guided registration session is awaiting a field", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("kkkk"));

    expect(routed).toEqual({ ok: true, value: null });
    expect(sessions.get(playerId)).toMatchObject({
      mode: "GUIDED",
      currentField: "trainerName",
      working: { regionId: ZHOULIA_ID },
      dirty: false,
    });
  });

  it("still consumes an explicit reply while a guided registration field is active", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("Liora Vale", "bot-registration-prompt"));

    expect(routed).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: playerId,
      },
    });
    expect(sessions.get(playerId)).toMatchObject({
      mode: "GUIDED",
      currentField: "age",
      working: { trainerName: "Liora Vale", regionId: ZHOULIA_ID },
      dirty: true,
    });
  });
});
