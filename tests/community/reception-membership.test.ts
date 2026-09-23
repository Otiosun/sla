import { describe, expect, it, vi } from "vitest";
import {
  ReceptionMembershipService,
  ROTOM_WELCOME_IMAGE_URL,
} from "../../src/modules/community/reception-membership.js";
import { ReceptionService } from "../../src/modules/community/reception-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const event = {
  provider: "baileys",
  chatRef: "120363000000000001@g.us",
  externalId: "123456789@lid",
  action: "add",
} as const;

function harness(
  options: {
    role?: "RECEPTION" | "GAME";
    draft?: boolean;
    active?: boolean;
    unknown?: boolean;
  } = {},
) {
  const playerId = createPlayerId();
  const community = {
    resolveChat: async () => ({
      known: true,
      groupId: "group",
      role: options.role ?? "RECEPTION",
      capabilities: ["onboarding"] as const,
    }),
  };
  const players = {
    resolvePlayer: vi.fn(async () =>
      options.unknown ? err(appError("NOT_FOUND", "No identity")) : ok({ playerId }),
    ),
    resolveOrCreatePlayer: vi.fn(async () => ok({ playerId })),
  };
  const reception = new ReceptionService({
    community,
    players,
    access: {
      load: async () => ({
        playerId,
        status: options.active ? "ACTIVE" : "PENDING",
        approvedReviewId: null,
        revision: 0,
      }),
    },
    registration: {
      getCurrentReview: async () => err(appError("NOT_FOUND", "No review")),
      getDraft: async () =>
        options.draft ? ok({ revision: 6 }) : err(appError("NOT_FOUND", "No draft")),
    },
    presence: {
      needsFirstWelcome: async () => true,
      claimFirstWelcome: async () => {
        throw new Error("membership must use atomic presence/outbox");
      },
    },
  });
  const recordMembership = vi.fn(async (_input, welcome) => welcome());
  const service = new ReceptionMembershipService({
    community,
    players,
    reception,
    presence: { recordMembership },
  });
  return { service, recordMembership, players };
}

describe("Reception membership behavior", () => {
  it("sends the exact requested Rotom caption and original image with a real mention", async () => {
    const h = harness({ unknown: true });
    await h.service.handle(event);
    expect(await h.recordMembership.mock.results[0]?.value).toEqual({
      messageType: "IMAGE",
      payload: {
        imageUrl: ROTOM_WELCOME_IMAGE_URL,
        mentions: [event.externalId],
        caption:
          "🚨[ *BZZZT... BZZZT!* ]\n\n❗`NOVO TREINADOR DETECTADO: @123456789`❗\n\nEu sou Rotom! Pokédex autoaprendiz, especialista em Pokémon, treinadores e... praticamente tudo que importa por aqui, *roto!*\n\nSó tem um problema:\n\n> *Eu não faço ideia de quem é você.*\n\nE isso é péssimo para uma Pokédex. ⚡ Vamos corrigir isso! *Digite:*\n\n`/registrar`\n\n*Não fica parado aí!* Meu banco de dados não vai se preencher sozinho! ⚡",
      },
    });
  });

  it.each([
    { draft: true, command: "/continuar" },
    { active: true, command: "continua ativo" },
  ])("preserves returning player state: %o", async (options) => {
    const h = harness(options);
    await h.service.handle(event);
    const message = await h.recordMembership.mock.results[0]?.value;
    expect(message.messageType).toBe("TEXT");
    expect(message.payload.text).toContain(options.command);
    expect(message.payload.text).not.toContain("/registrar");
    expect(message.payload.mentions).toEqual([event.externalId]);
  });

  it("ignores non-Reception groups before creating identities or touching presence", async () => {
    const h = harness({ role: "GAME" });
    await h.service.handle(event);
    expect(h.players.resolveOrCreatePlayer).not.toHaveBeenCalled();
    expect(h.recordMembership).not.toHaveBeenCalled();
  });

  it("does not create a player for a leave notification", async () => {
    const h = harness({ unknown: true });
    await h.service.handle({ ...event, action: "remove" });
    expect(h.players.resolveOrCreatePlayer).not.toHaveBeenCalled();
    expect(h.recordMembership).not.toHaveBeenCalled();
  });
});
