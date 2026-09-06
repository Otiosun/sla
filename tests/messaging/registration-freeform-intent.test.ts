import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { RegistrationConversationResolver } from "../../src/modules/registration/conversation-resolver.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CURRENT_PROMPT_ID = "bot-current-registration-prompt";
const EXPECTED_OUTBOX_KEY = "registration:expected-outbox";

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
      provider: "baileys",
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
    replyIntent: {
      isExpectedReply: async (input) =>
        input.expectedOutboxIdempotencyKey === EXPECTED_OUTBOX_KEY &&
        input.replyToExternalMessageId === CURRENT_PROMPT_ID,
    },
  });
}

function expectCurrentPrompt(
  sessions: RegistrationConversationSessions,
  playerId: ReturnType<typeof createPlayerId>,
): void {
  const expected = sessions.expectReply(playerId, EXPECTED_OUTBOX_KEY);
  if (!expected.ok) throw new Error("Expected active registration session");
}

describe("registration freeform intent", () => {
  it("ignores a compact mode choice when it is not a reply", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("2"));

    expect(routed).toEqual({ ok: true, value: null });
    expect(sessions.get(playerId)).toMatchObject({ mode: "CHOOSING", dirty: false });
  });

  it("ignores a compact mode choice replying to an unrelated message", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("2", "some-human-message"));

    expect(routed).toEqual({ ok: true, value: null });
    expect(sessions.get(playerId)).toMatchObject({ mode: "CHOOSING", dirty: false });
  });

  it("accepts a compact mode choice only when replying to the current bot prompt", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("2", CURRENT_PROMPT_ID));

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
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("Tá, ótimo sinal"));

    expect(routed).toEqual({ ok: true, value: null });
    expect(sessions.get(playerId)).toMatchObject({ mode: "FULL", dirty: false });
  });

  it("ignores unrelated normal text while a guided registration session is awaiting a field", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    expectCurrentPrompt(sessions, playerId);
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

  it("ignores a reply to an unrelated message while a guided field is active", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("Liora Vale", "some-human-message"));

    expect(routed).toEqual({ ok: true, value: null });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: "trainerName",
      dirty: false,
    });
  });

  it("consumes a reply to the current prompt while a guided field is active", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("Liora Vale", CURRENT_PROMPT_ID));

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

  it("ignores replies once guided registration is no longer awaiting a field", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, {
      mode: "GUIDED",
      regionId: ZHOULIA_ID,
      baseDraft: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        appearance: "Casaco de viagem",
        personality: "Curiosa",
        backstory: "Pesquisadora",
        starterFormId: "44444444-4444-4444-8444-444444444444",
        regionId: ZHOULIA_ID,
        schemaVersion: 1,
      },
    });
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("E também tipo uma apresentação", CURRENT_PROMPT_ID));

    expect(routed).toEqual({ ok: true, value: null });
  });

  it("ignores further replies after a full form has already been consumed", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "FULL", regionId: ZHOULIA_ID });
    sessions.setField(playerId, "trainerName", "Liora Vale");
    expectCurrentPrompt(sessions, playerId);
    const router = new MessageRouter([], undefined, resolverFor(sessions, playerId));

    const routed = await router.dispatch(context("qualquer coisa", CURRENT_PROMPT_ID));

    expect(routed).toEqual({ ok: true, value: null });
  });
});
