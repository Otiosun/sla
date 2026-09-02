import { describe, expect, it } from "vitest";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { RegistrationConversationResolver } from "../../src/modules/registration/conversation-resolver.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const SQUIRTLE_ID = "33333333-3333-4333-8333-333333333333";

function context(input: {
  readonly text: string;
  readonly chatRef?: string;
}): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000101",
    correlationId: "00000000-0000-4000-8000-000000000102",
    causationId: "00000000-0000-4000-8000-000000000101",
    idempotencyKey: "inbox:whatsapp:registration-routing-1",
    message: {
      provider: "whatsapp",
      externalMessageId: "registration-routing-1",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: input.chatRef ?? "120363000000000001@g.us",
      occurredAt: "2026-09-01T23:40:00.000Z",
      text: input.text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function onboardingContext() {
  return {
    known: true,
    groupId: "00000000-0000-4000-8000-000000000201",
    role: "RECEPTION" as const,
    capabilities: ["onboarding" as const, "player.basic" as const],
  };
}

function registrationSetup() {
  return {
    regionId: ZHOULIA_ID,
    regionDisplayName: "Zhoulia",
    starterOptions: [
      { formId: CHARMANDER_ID, displayName: "Charmander" },
      { formId: SQUIRTLE_ID, displayName: "Squirtle" },
    ],
  } as const;
}

describe("registration conversation routing", () => {
  it("turns an explicit mode choice into the requested editor without choosing for the player", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const router = new MessageRouter([], undefined, resolver);

    const routed = await router.dispatch(context({ text: "1" }));

    expect(routed).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: playerId,
        outgoing: [{ payload: { text: expect.stringContaining("Nome do treinador") } }],
      },
    });
    expect(sessions.get(playerId)).toMatchObject({
      mode: "GUIDED",
      currentField: "trainerName",
      dirty: false,
    });
  });

  it("consumes normal text only for an active guided session in an onboarding-capable group", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const router = new MessageRouter([], undefined, resolver);

    const routed = await router.dispatch(context({ text: "Liora Vale" }));

    expect(routed).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: playerId,
        outgoing: [{ payload: { text: expect.stringContaining("Idade") } }],
      },
    });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: "age",
      working: { trainerName: "Liora Vale" },
      dirty: true,
    });
  });

  it("canonicalizes a guided starter index before storing it in the working draft", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, {
      mode: "GUIDED",
      regionId: ZHOULIA_ID,
      baseDraft: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        appearance: "Cabelos negros.",
        personality: "Curiosa.",
        backstory: "Uma história curta.",
        regionId: ZHOULIA_ID,
        schemaVersion: 1,
      },
    });
    expect(sessions.get(playerId)?.currentField).toBe("starterFormId");
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const router = new MessageRouter([], undefined, resolver);

    const routed = await router.dispatch(context({ text: "2" }));

    expect(routed).toMatchObject({ ok: true });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: null,
      working: { starterFormId: SQUIRTLE_ID },
    });
  });

  it("ignores normal text in a group without onboarding capability and leaves the session untouched", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: "00000000-0000-4000-8000-000000000202",
          role: "GAME" as const,
          capabilities: ["world" as const],
        }),
      },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const router = new MessageRouter([], undefined, resolver);

    expect(await router.dispatch(context({ text: "Liora Vale", chatRef: "game@g.us" }))).toEqual({
      ok: true,
      value: null,
    });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: "trainerName",
      working: { regionId: ZHOULIA_ID },
      dirty: false,
    });
  });

  it("ignores normal text when the player has no active registration session", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const router = new MessageRouter([], undefined, resolver);

    expect(await router.dispatch(context({ text: "qualquer conversa normal" }))).toEqual({
      ok: true,
      value: null,
    });
  });

  it("applies a full ficha template and canonicalizes a starter display name without submitting it", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "FULL", regionId: ZHOULIA_ID });
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const router = new MessageRouter([], undefined, resolver);
    const ficha = [
      "Nome: Liora Vale",
      "Idade: 17",
      "Pronomes: ela/dela",
      "Aparência: Cabelos negros e casaco de viagem.",
      "Personalidade: Curiosa e competitiva.",
      "História: Saiu de casa para pesquisar Pokémon raros.",
      "Inicial: Charmander",
    ].join("\n");

    const routed = await router.dispatch(context({ text: ficha }));

    expect(routed).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: playerId,
        outgoing: [{ payload: { text: expect.stringContaining("$salvar") } }],
      },
    });
    expect(sessions.get(playerId)).toMatchObject({
      mode: "FULL",
      dirty: true,
      working: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        starterFormId: CHARMANDER_ID,
        regionId: ZHOULIA_ID,
      },
    });
  });
});
