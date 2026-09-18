import { describe, expect, it, vi } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { WorldServicePromptDeliveryPreparation } from "../../src/platform/world-services/world-service-prompt-delivery-preparation.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const SESSION: WorldServiceSessionRecord = {
  sessionId: "00000000-0000-4000-8000-000000000a01",
  playerId: PLAYER_ID,
  areaId: "00000000-0000-4000-8000-000000000a02",
  serviceKind: "POKEMART",
  state: "OPEN",
  sceneProofId: "00000000-0000-4000-8000-000000000a03",
  expectedReplyOutboxIdempotencyKey: "world-service:prompt:1",
  expectedReplyExternalMessageId: "WA-WORLD-PROMPT-1",
  revision: 1n,
  createdAt: new Date("2026-09-07T05:50:00.000Z"),
  updatedAt: new Date("2026-09-07T05:51:00.000Z"),
  closedAt: null,
};

function message(payload: Readonly<Record<string, unknown>>): PendingOutboxMessage {
  return {
    id: "00000000-0000-4000-8000-000000000b01",
    channel: "whatsapp",
    destinationRef: "120363000000000501@g.us",
    messageType: "TEXT",
    payload,
    idempotencyKey: "world-service:prompt:1",
    correlationId: "00000000-0000-4000-8000-000000000b02",
    causationId: "00000000-0000-4000-8000-000000000b03",
    attempts: 1,
  };
}

function fixture() {
  const setActivePrompt = vi.fn(async () => ok(SESSION));
  const preparation = new WorldServicePromptDeliveryPreparation({
    sessions: { setActivePrompt },
    providerMessageIdFor: () => "WA-WORLD-PROMPT-1",
  });
  return { preparation, setActivePrompt };
}

describe("WorldServicePromptDeliveryPreparation", () => {
  it("ignores unrelated outbound messages", async () => {
    const { preparation, setActivePrompt } = fixture();

    await preparation.prepare(message({ text: "mensagem comum" }));

    expect(setActivePrompt).not.toHaveBeenCalled();
  });

  it("persists the deterministic provider prompt identity before delivery", async () => {
    const { preparation, setActivePrompt } = fixture();

    await preparation.prepare(
      message({
        text: "menu",
        worldServicePrompt: {
          playerId: PLAYER_ID,
          expectedRevision: "0",
        },
      }),
    );

    expect(setActivePrompt).toHaveBeenCalledOnce();
    expect(setActivePrompt).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      expectedRevision: 0n,
      outboxIdempotencyKey: "world-service:prompt:1",
      externalMessageId: "WA-WORLD-PROMPT-1",
    });
  });

  it("rejects malformed prompt anchors instead of sending an unbound prompt", async () => {
    const { preparation, setActivePrompt } = fixture();

    await expect(
      preparation.prepare(
        message({
          text: "menu",
          worldServicePrompt: {
            playerId: PLAYER_ID,
            expectedRevision: "not-a-revision",
          },
        }),
      ),
    ).rejects.toThrow("Invalid World Service prompt delivery anchor");
    expect(setActivePrompt).not.toHaveBeenCalled();
  });
});
