import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { RegistrationConversationResolver } from "../../src/modules/registration/conversation-resolver.js";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const SQUIRTLE_ID = "33333333-3333-4333-8333-333333333333";

function context(input: {
  readonly text: string;
  readonly chatRef?: string;
  readonly replyToExternalMessageId?: string | null;
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
      replyToExternalMessageId: input.replyToExternalMessageId ?? "bot-registration-prompt",
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

function recoveryContext(input: {
  readonly text: string;
  readonly messageId: string;
  readonly replyTo: string;
}): MessageHandlerContext {
  const base = context({
    text: input.text,
    replyToExternalMessageId: input.replyTo,
  });
  return {
    ...base,
    inboxMessageId: `inbox-${input.messageId}`,
    causationId: `inbox-${input.messageId}`,
    idempotencyKey: `inbox:whatsapp:${input.messageId}`,
    message: {
      ...base.message,
      externalMessageId: input.messageId,
    },
  };
}

function fullFicha(
  input: {
    readonly age?: string;
    readonly starter?: string;
    readonly omitPersonality?: boolean;
  } = {},
): string {
  return [
    "Nome: Liora Vale",
    `Idade: ${input.age ?? "17"}`,
    "Pronomes: ela/dela",
    "Aparência: Cabelos negros e casaco de viagem.",
    ...(input.omitPersonality === true ? [] : ["Personalidade: Curiosa e competitiva."]),
    "História: Saiu de casa para pesquisar Pokémon raros.",
    `Inicial: ${input.starter ?? "Charmander"}`,
  ].join("\n");
}

describe("registration conversation routing", () => {
  it("recovers an invalid mode choice through a new exact reply anchor", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });
    sessions.expectReply(playerId, "registration:mode-prompt");
    const expectedByProviderMessage = new Map([
      ["mode-prompt-id", "registration:mode-prompt"],
      ["mode-correction-id", "inbox:whatsapp:invalid-mode:registration-conversation"],
    ]);
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
      replyIntent: {
        isExpectedReply: async (input) =>
          expectedByProviderMessage.get(input.replyToExternalMessageId) ===
          input.expectedOutboxIdempotencyKey,
      },
    });

    const invalid = await resolver.resolve(
      recoveryContext({ text: "talvez", messageId: "invalid-mode", replyTo: "mode-prompt-id" }),
    );
    expect(invalid).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          { payload: { text: expect.stringMatching(/1[\s\S]*guiad[\s\S]*2[\s\S]*complet/i) } },
        ],
      },
    });
    expect(sessions.get(playerId)).toMatchObject({
      mode: "CHOOSING",
      expectedReplyOutboxIdempotencyKey: "inbox:whatsapp:invalid-mode:registration-conversation",
    });

    const staleReply = recoveryContext({
      text: "1",
      messageId: "stale-mode-correction",
      replyTo: "mode-prompt-id",
    });
    expect(await resolver.admits(staleReply.message)).toBe(false);
    expect(await resolver.resolve(staleReply)).toEqual(ok(null));

    const corrected = await resolver.resolve(
      recoveryContext({ text: "1", messageId: "correct-mode", replyTo: "mode-correction-id" }),
    );
    expect(corrected).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringContaining("NOME DO TREINADOR") } }] },
    });
    expect(sessions.get(playerId)).toMatchObject({ mode: "GUIDED", currentField: "trainerName" });
  });

  it.each([
    {
      name: "invalid age",
      invalidFicha: fullFicha({ age: "dezessete" }),
      expected: /IDADE NÃO RECONHECIDA[\s\S]*número inteiro maior que zero/i,
    },
    {
      name: "missing required field",
      invalidFicha: fullFicha({ omitPersonality: true }),
      expected: /FICHA INCOMPLETA OU INVÁLIDA[\s\S]*Personalidade/i,
    },
    {
      name: "invalid starter",
      invalidFicha: fullFicha({ starter: "Pikachu" }),
      expected: /INICIAL NÃO RECONHECIDO[\s\S]*Charmander[\s\S]*Squirtle/i,
    },
  ])("recovers a FULL-mode $name without persisting partial input", async (testCase) => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "FULL", regionId: ZHOULIA_ID });
    sessions.expectReply(playerId, "registration:full-prompt");
    const correctionKey = `inbox:whatsapp:invalid-full-${testCase.name}:registration-conversation`;
    const expectedByProviderMessage = new Map([
      ["full-prompt-id", "registration:full-prompt"],
      ["full-correction-id", correctionKey],
    ]);
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
      replyIntent: {
        isExpectedReply: async (input) =>
          expectedByProviderMessage.get(input.replyToExternalMessageId) ===
          input.expectedOutboxIdempotencyKey,
      },
    });

    const invalid = await resolver.resolve(
      recoveryContext({
        text: testCase.invalidFicha,
        messageId: `invalid-full-${testCase.name}`,
        replyTo: "full-prompt-id",
      }),
    );
    expect(invalid).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringMatching(testCase.expected) } }] },
    });
    if (!invalid.ok || invalid.value === null) throw new Error("Expected FULL correction prompt");
    expect(invalid.value.outgoing[0]?.payload.text).toMatch(
      /Nome:[\s\S]*Idade:[\s\S]*Pokémon inicial:/i,
    );
    expect(invalid.value.outgoing[0]?.payload.text).not.toContain("Código de suporte");
    expect(sessions.get(playerId)).toMatchObject({
      mode: "FULL",
      dirty: false,
      working: { regionId: ZHOULIA_ID, schemaVersion: 1 },
      expectedReplyOutboxIdempotencyKey: correctionKey,
    });

    const staleReply = recoveryContext({
      text: fullFicha(),
      messageId: `stale-full-${testCase.name}`,
      replyTo: "full-prompt-id",
    });
    expect(await resolver.admits(staleReply.message)).toBe(false);
    expect(await resolver.resolve(staleReply)).toEqual(ok(null));

    const corrected = await resolver.resolve(
      recoveryContext({
        text: fullFicha(),
        messageId: `correct-full-${testCase.name}`,
        replyTo: "full-correction-id",
      }),
    );
    expect(corrected).toMatchObject({ ok: true });
    expect(sessions.get(playerId)).toMatchObject({
      mode: "FULL",
      dirty: true,
      working: { age: 17, personality: "Curiosa e competitiva.", starterFormId: CHARMANDER_ID },
    });
  });

  it("turns an invalid age into a new exact reply target and accepts the natural correction", async () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(playerId, "Liora Vale");
    sessions.expectReply(playerId, "registration:age-prompt");
    const expectedByProviderMessage = new Map([
      ["age-prompt-id", "registration:age-prompt"],
      ["age-correction-id", "inbox:whatsapp:invalid-age:registration-conversation"],
    ]);
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
      replyIntent: {
        isExpectedReply: async (input) =>
          expectedByProviderMessage.get(input.replyToExternalMessageId) ===
          input.expectedOutboxIdempotencyKey,
      },
    });

    const invalid = await resolver.resolve(
      recoveryContext({ text: "dezessete", messageId: "invalid-age", replyTo: "age-prompt-id" }),
    );
    expect(invalid).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(/idade[\s\S]*número inteiro maior que zero/i),
            },
          },
        ],
      },
    });
    if (!invalid.ok || invalid.value === null) throw new Error("Expected age correction prompt");
    expect(invalid.value.outgoing[0]?.payload.text).not.toContain("Código de suporte");
    expect(sessions.get(playerId)).toMatchObject({
      currentField: "age",
      expectedReplyOutboxIdempotencyKey: "inbox:whatsapp:invalid-age:registration-conversation",
      working: { trainerName: "Liora Vale" },
    });

    const staleReply = recoveryContext({
      text: "17",
      messageId: "stale-age-correction",
      replyTo: "age-prompt-id",
    });
    expect(await resolver.admits(staleReply.message)).toBe(false);
    expect(await resolver.resolve(staleReply)).toEqual(ok(null));

    const corrected = await resolver.resolve(
      recoveryContext({ text: "17", messageId: "correct-age", replyTo: "age-correction-id" }),
    );
    expect(corrected).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringMatching(/Gênero|pronomes/i) } }] },
    });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: "genderPronouns",
      working: { age: 17 },
    });
  });

  it("turns an invalid starter into a new exact reply target with the valid choices", async () => {
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
    sessions.expectReply(playerId, "registration:starter-prompt");
    const expectedByProviderMessage = new Map([
      ["starter-prompt-id", "registration:starter-prompt"],
      ["starter-correction-id", "inbox:whatsapp:invalid-starter:registration-conversation"],
    ]);
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
      replyIntent: {
        isExpectedReply: async (input) =>
          expectedByProviderMessage.get(input.replyToExternalMessageId) ===
          input.expectedOutboxIdempotencyKey,
      },
    });

    const invalid = await resolver.resolve(
      recoveryContext({
        text: "Pikachu",
        messageId: "invalid-starter",
        replyTo: "starter-prompt-id",
      }),
    );
    expect(invalid).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(
                /INICIAL NÃO RECONHECIDO[\s\S]*1\. Charmander[\s\S]*2\. Squirtle[\s\S]*número ou o nome/i,
              ),
            },
          },
        ],
      },
    });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: "starterFormId",
      expectedReplyOutboxIdempotencyKey: "inbox:whatsapp:invalid-starter:registration-conversation",
    });

    const corrected = await resolver.resolve(
      recoveryContext({
        text: "2",
        messageId: "correct-starter",
        replyTo: "starter-correction-id",
      }),
    );
    expect(corrected).toMatchObject({ ok: true });
    expect(sessions.get(playerId)).toMatchObject({
      currentField: null,
      working: { starterFormId: SQUIRTLE_ID },
    });
  });

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
        outgoing: [{ payload: { text: expect.stringContaining("NOME DO TREINADOR") } }],
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
        outgoing: [{ payload: { text: expect.stringContaining("IDADE") } }],
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
        outgoing: [{ payload: { text: expect.stringContaining("/salvar") } }],
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

it.each(["/", "/menu", "$menu"])(
  "does not consume a command as a trainer field: %s",
  async (text) => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    const resolver = new RegistrationConversationResolver({
      sessions,
      community: { resolveChat: async () => onboardingContext() },
      players: { resolvePlayer: async () => ok({ playerId, state: "NEW" as const }) },
      setup: { load: async () => ok(registrationSetup()) },
    });
    const input = context({ text });
    expect(await resolver.admits(input.message)).toBe(false);
    expect(await resolver.resolve(input)).toEqual(ok(null));
    expect(sessions.get(playerId)?.working.trainerName).toBeUndefined();
  },
);
