import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { ReceptionService } from "../../src/modules/community/reception-service.js";
import { RegistrationConversationResolver } from "../../src/modules/registration/conversation-resolver.js";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { createRegistrationAdminWhatsAppRoutes } from "../../src/modules/registration/admin-review-whatsapp.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const BULBASAUR_ID = "33333333-3333-4333-8333-333333333333";
const SQUIRTLE_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_ID = "55555555-5555-4555-8555-555555555555";

function context(
  text: string,
  replyToExternalMessageId: string | null = null,
): MessageHandlerContext {
  return {
    inboxMessageId: "66666666-6666-4666-8666-666666666666",
    correlationId: "77777777-7777-4777-8777-777777777777",
    causationId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: `inbox:baileys:${text}`,
    message: {
      provider: "baileys",
      externalMessageId: `message:${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-05T18:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId,
    },
  };
}

function setup() {
  return {
    regionId: ZHOULIA_ID,
    regionDisplayName: "Zhoulia",
    starterOptions: [
      { formId: BULBASAUR_ID, displayName: "Bulbasaur" },
      { formId: CHARMANDER_ID, displayName: "Charmander" },
      { formId: SQUIRTLE_ID, displayName: "Squirtle" },
    ],
  } as const;
}

function outgoingText(
  result: Awaited<ReturnType<RegistrationConversationResolver["resolve"]>>,
): string {
  if (!result.ok || result.value === null) throw new Error("Expected outgoing registration text");
  const text = result.value.outgoing[0]?.payload.text;
  if (typeof text !== "string") throw new Error("Expected text payload");
  return text;
}

describe("Reception UX polish", () => {
  it("welcomes a new player as an arrival in Zhoulia instead of a bare registration instruction", async () => {
    const service = new ReceptionService({
      community: {
        resolveChat: async () => ({
          known: true as const,
          groupId: "88888888-8888-4888-8888-888888888888",
          role: "RECEPTION" as const,
          capabilities: ["onboarding" as const],
        }),
      },
      players: {
        resolvePlayer: async () => err(appError("NOT_FOUND", "not registered")),
        resolveOrCreatePlayer: async () => ok({ playerId: PLAYER_ID }),
      },
      registration: {
        getCurrentReview: async () => err(appError("NOT_FOUND", "no review")),
        getDraft: async () => err(appError("NOT_FOUND", "no draft")),
      },
      access: {
        load: async () => ({
          playerId: PLAYER_ID,
          status: "PENDING" as const,
          approvedReviewId: null,
          revision: 0,
        }),
      },
      presence: {
        needsFirstWelcome: async () => true,
        claimFirstWelcome: async () => true,
      },
    });

    const result = await service.firstInteraction({
      provider: "baileys",
      chatRef: "120363000000000001@g.us",
      externalId: "5511999999999@s.whatsapp.net",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.value === null) throw new Error("Expected reception welcome");
    expect(result.value.text).toMatch(/Zhoulia/i);
    expect(result.value.text).toMatch(/jornada|treinador/i);
    expect(result.value.text).not.toBe(
      "🎒 Bem-vindo à Recepção. Você ainda não possui ficha. Use `$registrar` para começar.",
    );
  });

  it("keeps guided follow-up prompts short instead of repeating persistence warnings", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });

    const resolver = new RegistrationConversationResolver({
      sessions,
      community: {
        resolveChat: async () => ({
          known: true as const,
          groupId: "88888888-8888-4888-8888-888888888888",
          role: "RECEPTION" as const,
          capabilities: ["onboarding" as const],
        }),
      },
      players: {
        resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" }),
      },
      setup: { load: async () => ok(setup()) },
    });

    const text = outgoingText(await resolver.resolve(context("Liora Vale")));
    expect(text).toMatch(/Idade/i);
    expect(text).not.toMatch(/Nada será salvo definitivamente/i);
    expect(text.length).toBeLessThan(90);
  });

  it("shows the canonical starter choices when guided registration reaches Pokémon inicial", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(PLAYER_ID, "Liora Vale");
    sessions.applyGuidedAnswer(PLAYER_ID, "17");
    sessions.applyGuidedAnswer(PLAYER_ID, "ela/dela");
    sessions.applyGuidedAnswer(PLAYER_ID, "Cabelos negros e casaco de viagem.");
    sessions.applyGuidedAnswer(PLAYER_ID, "Curiosa e competitiva.");

    const resolver = new RegistrationConversationResolver({
      sessions,
      community: {
        resolveChat: async () => ({
          known: true as const,
          groupId: "88888888-8888-4888-8888-888888888888",
          role: "RECEPTION" as const,
          capabilities: ["onboarding" as const],
        }),
      },
      players: {
        resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" }),
      },
      setup: { load: async () => ok(setup()) },
    });

    const text = outgoingText(
      await resolver.resolve(context("Saiu de casa para pesquisar Pokémon raros.")),
    );
    expect(text).toMatch(/Pokémon inicial/i);
    expect(text).toMatch(/1\. Bulbasaur/);
    expect(text).toMatch(/2\. Charmander/);
    expect(text).toMatch(/3\. Squirtle/);
    expect(text).toMatch(/número|nome/i);
  });

  it("renders the admin ficha with friendly status, starter and region names instead of internal IDs", async () => {
    const deps = {
      messageRefs: {
        findByProviderMessage: async () => ({
          provider: "baileys",
          providerExternalMessageId: "review-message",
          outboxMessageId: "99999999-9999-4999-8999-999999999999",
          reviewId: REVIEW_ID,
          reviewRevision: 4,
        }),
      },
      admins: {
        resolvePrincipal: async () => ({ principalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      },
      setup: { load: async () => ok(setup()) },
      registration: {
        getReview: async () =>
          ok({
            id: REVIEW_ID,
            playerId: PLAYER_ID,
            sequenceNo: 2,
            status: "SUBMITTED" as const,
            revision: 4,
            snapshot: {
              trainerName: "Liora Vale",
              age: 17,
              genderPronouns: "ela/dela",
              appearance: "Cabelos negros e casaco de viagem.",
              personality: "Curiosa e competitiva.",
              backstory: "Saiu de casa para pesquisar Pokémon raros.",
              starterFormId: CHARMANDER_ID,
              regionId: ZHOULIA_ID,
              schemaVersion: 1,
            },
          }),
        requestChanges: async () => err(appError("ACTION_INVALID", "unused")),
        approve: async () => err(appError("ACTION_INVALID", "unused")),
        reject: async () => err(appError("ACTION_INVALID", "unused")),
      },
    };
    const route = createRegistrationAdminWhatsAppRoutes(deps as never).find(
      (candidate) => candidate.command === "verficha",
    );
    if (route === undefined) throw new Error("Missing verficha route");

    const result = await route.handler.handle(context("$verficha", "review-message"));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected admin ficha");
    const text = result.value.outgoing[0]?.payload.text;
    if (typeof text !== "string") throw new Error("Expected admin ficha text");

    expect(text).toMatch(/Em análise/i);
    expect(text).toMatch(/Charmander/);
    expect(text).toMatch(/Zhoulia/);
    expect(text).not.toContain(CHARMANDER_ID);
    expect(text).not.toContain(ZHOULIA_ID);
    expect(text).not.toMatch(/Status: SUBMITTED|Revisão:/i);
  });
});
