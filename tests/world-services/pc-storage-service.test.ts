import { describe, expect, it, vi } from "vitest";
import {
  PokemonPcStorageService,
  type PokemonPcStorageRepository,
  type PokemonPcStorageSnapshot,
} from "../../src/modules/world-services/pc-storage-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";

const PLAYER_ID = createPlayerId();
const TEAM_POKEMON_ID = createPokemonInstanceId();
const BOX_POKEMON_ID = createPokemonInstanceId();

const SNAPSHOT: PokemonPcStorageSnapshot = {
  playerId: PLAYER_ID,
  team: [
    {
      pokemonInstanceId: TEAM_POKEMON_ID,
      displayName: "Bulbasaur",
      level: 5,
      placementKind: "TEAM",
      boxNo: null,
      slotNo: 1,
    },
  ],
  boxes: [
    {
      boxNo: 1,
      occupied: 1,
      capacity: 30,
      pokemon: [
        {
          pokemonInstanceId: BOX_POKEMON_ID,
          displayName: "Pidgey",
          level: 4,
          placementKind: "BOX",
          boxNo: 1,
          slotNo: 1,
        },
      ],
    },
  ],
};

function repository(
  overrides: Partial<PokemonPcStorageRepository> = {},
): PokemonPcStorageRepository {
  return {
    loadStorage: vi.fn(async () => SNAPSHOT),
    deposit: vi.fn(async () => ({
      kind: "APPLIED" as const,
      pokemonInstanceId: TEAM_POKEMON_ID,
      fromSlotNo: 2,
      boxNo: 1,
      slotNo: 2,
    })),
    withdraw: vi.fn(async () => ({
      kind: "APPLIED" as const,
      pokemonInstanceId: BOX_POKEMON_ID,
      fromBoxNo: 1,
      fromSlotNo: 1,
      teamSlotNo: 2,
    })),
    organize: vi.fn(async () => ({
      kind: "APPLIED" as const,
      pokemonInstanceId: BOX_POKEMON_ID,
      fromBoxNo: 1,
      fromSlotNo: 1,
      toBoxNo: 2,
      toSlotNo: 3,
    })),
    ...overrides,
  };
}

describe("Pokemon PC storage service", () => {
  it("returns the persisted team and box read model", async () => {
    const repo = repository();
    const service = new PokemonPcStorageService(repo);

    const result = await service.getStorage(PLAYER_ID);

    expect(result).toEqual({ ok: true, value: SNAPSHOT });
    expect(repo.loadStorage).toHaveBeenCalledWith(PLAYER_ID);
  });

  it("rejects depositing the last team Pokemon without leaking persistence details", async () => {
    const repo = repository({
      deposit: vi.fn(async () => ({ kind: "LAST_TEAM_MEMBER" as const })),
    });
    const service = new PokemonPcStorageService(repo);

    const result = await service.deposit({
      playerId: PLAYER_ID,
      pokemonInstanceId: TEAM_POKEMON_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        message: "At least one Pokemon must remain in the team",
      },
    });
  });

  it("rejects withdrawal when the team already has six Pokemon", async () => {
    const repo = repository({
      withdraw: vi.fn(async () => ({ kind: "TEAM_FULL" as const })),
    });
    const service = new PokemonPcStorageService(repo);

    const result = await service.withdraw({
      playerId: PLAYER_ID,
      pokemonInstanceId: BOX_POKEMON_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        message: "The Pokemon team already has six members",
      },
    });
  });

  it("rejects organizing into an occupied box slot", async () => {
    const repo = repository({
      organize: vi.fn(async () => ({ kind: "DESTINATION_OCCUPIED" as const })),
    });
    const service = new PokemonPcStorageService(repo);

    const result = await service.organize({
      playerId: PLAYER_ID,
      pokemonInstanceId: BOX_POKEMON_ID,
      boxNo: 2,
      slotNo: 3,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ACTION_INVALID",
        message: "The destination Pokemon PC slot is already occupied",
      },
    });
  });
});
