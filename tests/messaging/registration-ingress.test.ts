import { describe, expect, it } from "vitest";
import { RegistrationConversationResolver } from "../../src/modules/registration/conversation-resolver.js";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const RECEPTION = "120363000000000001@g.us";

function message(input: { readonly text: string; readonly chatRef?: string }): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `ingress-${input.text}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: input.chatRef ?? RECEPTION,
    occurredAt: "2026-09-02T04:15:00.000Z",
    text: input.text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  };
}

function resolver(input: {
  readonly sessions: RegistrationConversationSessions;
  readonly onboarding?: boolean;
}) {
  return new RegistrationConversationResolver({
    sessions: input.sessions,
    community: {
      resolveChat: async ({ chatRef }) =>
        input.onboarding !== false && chatRef === RECEPTION
          ? {
              known: true,
              groupId: "00000000-0000-4000-8000-000000000201",
              role: "RECEPTION" as const,
              capabilities: ["onboarding" as const, "player.basic" as const],
            }
          : {
              known: true,
              groupId: "00000000-0000-4000-8000-000000000202",
              role: "GAME" as const,
              capabilities: ["world" as const],
            },
    },
    players: {
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" }),
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

describe("registration freeform ingress", () => {
  it("admits ordinary text only for an active registration session in an onboarding-capable group", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    const registration = resolver({ sessions });

    expect(await registration.admits(message({ text: "Liora Vale" }))).toBe(true);
    expect(
      await registration.admits(message({ text: "Charmander observa o mato.", chatRef: "game@g.us" })),
    ).toBe(false);
    expect(await registration.admits(message({ text: "$ficha" }))).toBe(false);
  });

  it("rejects ordinary text when no registration session exists", async () => {
    const registration = resolver({ sessions: new RegistrationConversationSessions() });

    expect(await registration.admits(message({ text: "Liora Vale" }))).toBe(false);
  });
});
