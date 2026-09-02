import { describe, expect, it } from "vitest";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { createRegistrationWhatsAppRoutes } from "../../src/modules/registration/whatsapp-handlers.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000301",
    correlationId: "00000000-0000-4000-8000-000000000302",
    causationId: "00000000-0000-4000-8000-000000000301",
    idempotencyKey: `inbox:whatsapp:${text}`,
    message: {
      provider: "whatsapp",
      externalMessageId: `registration-command-${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-02T02:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function dependencies(sessions = new RegistrationConversationSessions()) {
  return {
    sessions,
    players: {
      resolveOrCreatePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: "NEW" as const, created: true }),
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
    },
    setup: {
      load: async () =>
        ok({
          regionId: ZHOULIA_ID,
          regionDisplayName: "Zhoulia",
          starterOptions: [],
        }),
    },
  };
}

function route(command: string, sessions = new RegistrationConversationSessions()) {
  const routes = createRegistrationWhatsAppRoutes(dependencies(sessions));
  const found = routes.find((candidate) => candidate.command === command);
  if (found === undefined) throw new Error(`Missing registration route ${command}`);
  return { found, sessions };
}

describe("registration WhatsApp commands", () => {
  it("declares reception-only pending-player policy for the player registration commands", () => {
    const routes = createRegistrationWhatsAppRoutes(dependencies());
    for (const command of ["registrar", "modo", "ficha"]) {
      expect(routes.find((candidate) => candidate.command === command)?.policy).toEqual({
        requiredGroupCapabilities: ["onboarding"],
        allowedPlayerAccess: ["PENDING"],
      });
    }
  });

  it("starts registration by asking the player to choose a mode instead of consuming a name argument", async () => {
    const sessions = new RegistrationConversationSessions();
    const { found } = route("registrar", sessions);

    const result = await found.handler.handle(context("$registrar Nome Que Deve Ser Ignorado"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: PLAYER_ID,
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(/1.*guiado[\s\S]*2.*ficha completa/i),
            },
          },
        ],
      },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "CHOOSING",
      currentField: null,
      dirty: false,
      working: { regionId: ZHOULIA_ID, schemaVersion: 1 },
    });
    expect(sessions.get(PLAYER_ID)?.working.trainerName).toBeUndefined();
  });

  it("switches the active editor mode without discarding working values", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(PLAYER_ID, "Liora Vale");
    const { found } = route("modo", sessions);

    const result = await found.handler.handle(context("$modo completo"));

    expect(result).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringContaining("FICHA COMPLETA") } }] },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "FULL",
      working: { trainerName: "Liora Vale", regionId: ZHOULIA_ID },
      dirty: true,
    });
  });

  it("renders the current working ficha and marks unsaved changes without persisting anything", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(PLAYER_ID, "Liora Vale");
    sessions.applyGuidedAnswer(PLAYER_ID, "17");
    const { found } = route("ficha", sessions);

    const result = await found.handler.handle(context("$ficha"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: PLAYER_ID,
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(/Liora Vale[\s\S]*17[\s\S]*Zhoulia[\s\S]*não salvas/i),
            },
          },
        ],
      },
    });
  });
});
