import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { createEncounterId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

function encounterView(encounterId: string, revision: string, status = "PRESENTED") {
  return {
    encounterId,
    areaId: "11111111-1111-4111-8111-111111111111",
    status,
    revision,
    createdAt: "2026-09-10T03:00:00.000Z",
    updatedAt: "2026-09-10T03:00:00.000Z",
    expiresAt: "2026-09-10T03:05:00.000Z",
    closedAt: null,
    wild: {
      formId: "22222222-2222-4222-8222-222222222222",
      displayName: "Pidgey",
      nationalDex: 16,
      typeNames: ["Normal", "Flying"],
      level: 3,
      currentHp: 12,
      maxHp: 12,
      shiny: false,
      gender: "FEMALE",
    },
  };
}

function handler(encounter: Record<string, unknown>): PlayerPortalHttpHandler {
  return new PlayerPortalHttpHandler({
    tickets: { redeem: async () => ok(identity) },
    sessions: {
      issue: () => ok({ token: "session-token", expiresAt: new Date("2026-09-10T12:00:00.000Z") }),
      verify: () => ok(identity),
    },
    player: {
      getSelf: async () => ok({} as never),
      getPokemon: async () => ok([]),
    },
    world: {
      getLocation: async () => ok({} as never),
      travel: async () => ok({} as never),
    },
    encounter,
  } as never);
}

const sessionHeaders = {
  cookie: "__Host-pokemon_hub_session=session-token",
  "content-type": "application/json",
};

describe("Player Portal encounter HTTP", () => {
  it("creates an encounter for the authenticated identity without accepting browser playerId", async () => {
    const encounterId = createEncounterId();
    let received: unknown = null;
    const response = await handler({
      create: async (receivedIdentity: ExternalIdentity, input: unknown) => {
        received = { identity: receivedIdentity, input };
        return ok(encounterView(encounterId, "1"));
      },
    }).handle(
      new Request("https://api.example.test/v1/hub/encounters", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          idempotencyKey: "hub-encounter-00000001",
          encounterTableSlug: "grass",
          playerId: "browser-must-not-control-this",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({
      identity,
      input: {
        idempotencyKey: "hub-encounter-00000001",
        encounterTableSlug: "grass",
      },
    });
    await expect(response.json()).resolves.toEqual({
      encounter: encounterView(encounterId, "1"),
    });
  });

  it("injects encounter id from the route into authenticated mutations", async () => {
    const encounterId = createEncounterId();
    let received: unknown = null;
    const response = await handler({
      engage: async (receivedIdentity: ExternalIdentity, input: unknown) => {
        received = { identity: receivedIdentity, input };
        return ok(encounterView(encounterId, "3", "ENGAGED"));
      },
    }).handle(
      new Request(`https://api.example.test/v1/hub/encounters/${encounterId}/engage`, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          expectedRevision: "2",
          playerId: "browser-must-not-control-this",
          encounterId: "browser-must-not-control-this-either",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({
      identity,
      input: { encounterId, expectedRevision: "2" },
    });
    await expect(response.json()).resolves.toMatchObject({
      encounter: { encounterId, status: "ENGAGED", revision: "3" },
    });
  });
});
