import { describe, expect, it } from "vitest";
import {
  encounterConditionsAllow,
  parseEncounterConditions,
} from "../../src/modules/catalog/encounter-contracts.js";
import type {
  EncounterTableEntryRecord,
  WildPokemonBuild,
} from "../../src/modules/encounter/contracts.js";
import {
  chooseEncounterLevel,
  chooseWeightedEncounterEntry,
  generateWildPokemon,
} from "../../src/modules/encounter/generation.js";
import { resolveEncounterRulesetPolicy } from "../../src/modules/encounter/policy.js";
import { encounterStateMachine } from "../../src/modules/encounter/state.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";

const OPEN = {
  schemaVersion: 1,
  requiredUnlockKeys: [],
  blockedUnlockKeys: [],
} as const;

const entries: readonly EncounterTableEntryRecord[] = [
  {
    entryId: "pidgey",
    formId: "pidgey-form",
    weight: 50,
    minLevel: 2,
    maxLevel: 4,
    active: true,
    conditions: OPEN,
  },
  {
    entryId: "rattata",
    formId: "rattata-form",
    weight: 40,
    minLevel: 2,
    maxLevel: 4,
    active: true,
    conditions: OPEN,
  },
  {
    entryId: "pikachu",
    formId: "pikachu-form",
    weight: 10,
    minLevel: 3,
    maxLevel: 5,
    active: true,
    conditions: OPEN,
  },
];

const wildBuild: WildPokemonBuild = {
  formId: "pidgey-form",
  speciesId: "pidgey-species",
  type1Id: "normal",
  type2Id: "flying",
  baseStats: {
    hp: 40,
    attack: 45,
    defense: 40,
    spAttack: 35,
    spDefense: 35,
    speed: 56,
  },
  abilityIds: ["keen-eye", "tangled-feet"],
  natureIds: ["hardy", "timid", "adamant"],
  moves: [
    { moveId: "tackle", learnMethod: "START", learnLevel: null, maxPp: 35 },
    { moveId: "gust", learnMethod: "LEVEL", learnLevel: 5, maxPp: 35 },
    { moveId: "quick-attack", learnMethod: "LEVEL", learnLevel: 7, maxPp: 30 },
  ],
};

describe("encounter core", () => {
  it("normalizes legacy open conditions and evaluates allowlisted unlock gates", () => {
    const legacy = parseEncounterConditions({});
    expect(legacy.success).toBe(true);
    if (!legacy.success) return;
    expect(encounterConditionsAllow(legacy.data, new Set())).toBe(true);

    const gated = parseEncounterConditions({
      schemaVersion: 1,
      requiredUnlockKeys: ["badge.boulder"],
      blockedUnlockKeys: ["story.rocket-active"],
    });
    expect(gated.success).toBe(true);
    if (!gated.success) return;
    expect(encounterConditionsAllow(gated.data, new Set(["badge.boulder"]))).toBe(true);
    expect(
      encounterConditionsAllow(gated.data, new Set(["badge.boulder", "story.rocket-active"])),
    ).toBe(false);
  });

  it("replays the same RNG sequence from the same 256-bit seed and counter", () => {
    const seed = Buffer.alloc(32, 0x5a);
    const first = new CounterRandomSource(seed);
    const values = Array.from({ length: 32 }, () => first.randomInt(1_000_003));
    const replay = new CounterRandomSource(seed);
    expect(Array.from({ length: 32 }, () => replay.randomInt(1_000_003))).toEqual(values);
    expect(replay.counter).toBe(first.counter);

    const resumed = new CounterRandomSource(seed, 16n);
    const canonical = new CounterRandomSource(seed);
    for (let index = 0; index < 16; index += 1) canonical.randomInt(1_000_003);
    expect(resumed.randomInt(1_000_003)).toBe(canonical.randomInt(1_000_003));
  });

  it("tracks weighted probabilities within a conservative deterministic tolerance", () => {
    const rng = new CounterRandomSource(Buffer.alloc(32, 0x31));
    const counts = new Map<string, number>();
    const samples = 20_000;
    for (let index = 0; index < samples; index += 1) {
      const selected = chooseWeightedEncounterEntry(entries, rng);
      counts.set(selected.entryId, (counts.get(selected.entryId) ?? 0) + 1);
    }

    const ratio = (id: string) => (counts.get(id) ?? 0) / samples;
    expect(ratio("pidgey")).toBeGreaterThan(0.47);
    expect(ratio("pidgey")).toBeLessThan(0.53);
    expect(ratio("rattata")).toBeGreaterThan(0.37);
    expect(ratio("rattata")).toBeLessThan(0.43);
    expect(ratio("pikachu")).toBeGreaterThan(0.08);
    expect(ratio("pikachu")).toBeLessThan(0.12);
  });

  it("generates an identical wild snapshot when replayed from the same seed", () => {
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const seed = Buffer.alloc(32, 0x77);
    const firstRng = new CounterRandomSource(seed);
    const secondRng = new CounterRandomSource(seed);
    const firstLevel = chooseEncounterLevel(entry, firstRng);
    const secondLevel = chooseEncounterLevel(entry, secondRng);
    const first = generateWildPokemon(wildBuild, firstLevel, firstRng);
    const second = generateWildPokemon(wildBuild, secondLevel, secondRng);

    expect(second).toEqual(first);
    expect(first.level).toBeGreaterThanOrEqual(2);
    expect(first.level).toBeLessThanOrEqual(4);
    expect(Object.values(first.ivs).every((value) => value >= 0 && value <= 31)).toBe(true);
    expect(first.currentHp).toBe(first.maxHp);
    expect(first.moves).toHaveLength(1);
    expect(first.moves[0]?.moveId).toBe("tackle");
  });

  it("keeps legacy rulesets valid while honoring explicit encounter policy", () => {
    expect(
      resolveEncounterRulesetPolicy({
        schemaVersion: 1,
        capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 9_500 },
      }),
    ).toEqual({ expirationSeconds: 900, captureAllowedStates: ["IN_BATTLE"] });

    expect(
      resolveEncounterRulesetPolicy({
        schemaVersion: 1,
        encounter: { expirationSeconds: 120 },
        capture: {
          model: "POKEMON_INSPIRED_V1",
          maxProbabilityBasisPoints: 9_500,
          allowedEncounterStates: ["ENGAGED", "IN_BATTLE"],
        },
      }),
    ).toEqual({
      expirationSeconds: 120,
      captureAllowedStates: ["ENGAGED", "IN_BATTLE"],
    });
  });

  it("enforces the encounter lifecycle transition graph", () => {
    expect(encounterStateMachine.canTransition("CREATED", "PRESENTED")).toBe(true);
    expect(encounterStateMachine.canTransition("PRESENTED", "ENGAGED")).toBe(true);
    expect(encounterStateMachine.canTransition("ENGAGED", "IN_BATTLE")).toBe(true);
    expect(encounterStateMachine.canTransition("ENGAGED", "CAPTURE_RESOLVING")).toBe(true);
    expect(encounterStateMachine.canTransition("CREATED", "CAPTURED")).toBe(false);
    expect(encounterStateMachine.canTransition("CLOSED", "CREATED")).toBe(false);
  });
});
