import { describe, expect, it, vi } from "vitest";
import type {
  Player360SearchResultView,
  Player360View,
} from "../../src/modules/admin/player360-contracts.js";
import { AdminReadFacade } from "../../src/adapters/admin-api/read-facade.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";

const SESSION_PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const SPOOFED_PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const PLAYER_ID = "33333333-3333-4333-8333-333333333333";

const emptySearchResult: Player360SearchResultView = {
  items: [],
  nextCursor: null,
};

const placeholderView = {} as Player360View;

function createFacade() {
  const search = vi.fn(async (_request: unknown) => emptySearchResult);
  const get = vi.fn(async (_request: unknown) => placeholderView);
  const facade = new AdminReadFacade({ search, get });
  return { facade, search, get };
}

describe("AdminReadFacade", () => {
  it("injects principalId from trusted session context for player search", async () => {
    const { facade, search } = createFacade();

    await facade.searchPlayers(
      { principalId: SESSION_PRINCIPAL, environment: "STAGING" },
      {
        principalId: SPOOFED_PRINCIPAL,
        trainerNamePrefix: "Ash",
        includeSensitive: false,
        limit: 25,
      },
    );

    expect(search).toHaveBeenCalledWith({
      principalId: SESSION_PRINCIPAL,
      trainerNamePrefix: "Ash",
      includeSensitive: false,
      limit: 25,
    });
  });

  it("does not let client input override environment or route playerId", async () => {
    const { facade, get } = createFacade();

    await facade.getPlayer(
      { principalId: SESSION_PRINCIPAL, environment: "PRODUCTION" },
      PLAYER_ID,
      {
        principalId: SPOOFED_PRINCIPAL,
        environment: "LOCAL",
        playerId: SPOOFED_PRINCIPAL,
        includeSensitive: false,
      },
    );

    expect(get).toHaveBeenCalledWith({
      principalId: SESSION_PRINCIPAL,
      playerId: PLAYER_ID,
      includeSensitive: false,
    });
  });

  it("fails closed when session context is missing or malformed", async () => {
    const { facade, search } = createFacade();

    await expect(facade.searchPlayers({}, {})).rejects.toMatchObject<Partial<AdminError>>({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
    });
    expect(search).not.toHaveBeenCalled();
  });
});
