import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import { withTransaction } from "../../src/platform/db/transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 4 vertical-slice seed");
}

const RULESET_KEY = "phase4-core-v1";
const RULESET_VERSION = 1;
const RELEASE_NO = 1n;
const RELEASE_NAME = "Phase 4 Vertical Slice v1";

const RULESET_CONFIG = {
  schemaVersion: 1,
  battle: {
    statModel: "SIX_STATS",
    physicalSpecialByMove: true,
    ivEnabled: true,
    evEnabled: false,
    natureEnabled: true,
    maxMoves: 4,
    ppEnabled: true,
    criticalMultiplierBasisPoints: 15_000,
    accuracyEvasionEnabled: true,
  },
  capture: {
    model: "POKEMON_INSPIRED_V1",
    maxProbabilityBasisPoints: 9_500,
  },
  defeat: { automaticMoneyLoss: false },
  narrative: { authority: "N0_FLAVOR_ONLY" },
} as const;

interface IdentityMap {
  readonly types: Readonly<Record<string, string>>;
  readonly species: Readonly<Record<string, string>>;
  readonly forms: Readonly<Record<string, string>>;
  readonly moves: Readonly<Record<string, string>>;
  readonly abilities: Readonly<Record<string, string>>;
  readonly items: Readonly<Record<string, string>>;
  readonly natures: Readonly<Record<string, string>>;
  readonly effects: Readonly<Record<string, string>>;
  readonly regionId: string;
  readonly areaId: string;
  readonly encounterTableId: string;
}

async function ensureSlugIdentity(
  client: PoolClient,
  table: "pokemon_types" | "moves" | "abilities" | "items" | "natures" | "effects" | "regions",
  slug: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ${table}(id, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [randomUUID(), slug],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE slug = $1`, [
    slug,
  ]);
  const id = existing.rows[0]?.id;
  if (id === undefined) throw new Error(`Failed to resolve ${table}:${slug}`);
  return id;
}

async function ensureSpecies(
  client: PoolClient,
  nationalDex: number,
  slug: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pokemon_species(id, national_dex, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (national_dex) DO NOTHING
     RETURNING id`,
    [randomUUID(), nationalDex, slug],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await client.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM pokemon_species WHERE national_dex = $1",
    [nationalDex],
  );
  const row = existing.rows[0];
  if (row === undefined || row.slug !== slug) {
    throw new Error(`National Dex ${nationalDex} is already bound to unexpected species`);
  }
  return row.id;
}

async function ensureForm(client: PoolClient, speciesId: string, slug: string): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pokemon_forms(id, species_id, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (species_id, slug) DO NOTHING
     RETURNING id`,
    [randomUUID(), speciesId, slug],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM pokemon_forms WHERE species_id = $1 AND slug = $2",
    [speciesId, slug],
  );
  const id = existing.rows[0]?.id;
  if (id === undefined) throw new Error("Failed to resolve Pokemon form");
  return id;
}

async function ensureArea(client: PoolClient, regionId: string, slug: string): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO areas(id, region_id, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (region_id, slug) DO NOTHING
     RETURNING id`,
    [randomUUID(), regionId, slug],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM areas WHERE region_id = $1 AND slug = $2",
    [regionId, slug],
  );
  const id = existing.rows[0]?.id;
  if (id === undefined) throw new Error("Failed to resolve area");
  return id;
}

async function ensureEncounterTable(
  client: PoolClient,
  areaId: string,
  slug: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO encounter_tables(id, area_id, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (area_id, slug) DO NOTHING
     RETURNING id`,
    [randomUUID(), areaId, slug],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM encounter_tables WHERE area_id = $1 AND slug = $2",
    [areaId, slug],
  );
  const id = existing.rows[0]?.id;
  if (id === undefined) throw new Error("Failed to resolve encounter table");
  return id;
}

async function ensureRuleset(client: PoolClient): Promise<{ id: string; status: string }> {
  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, $3, 1, $4::jsonb, 'DRAFT')
     ON CONFLICT (key, version) DO NOTHING`,
    [randomUUID(), RULESET_KEY, RULESET_VERSION, JSON.stringify(RULESET_CONFIG)],
  );
  const result = await client.query<{ id: string; status: string; config: unknown }>(
    "SELECT id, status, config FROM rulesets WHERE key = $1 AND version = $2",
    [RULESET_KEY, RULESET_VERSION],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Failed to resolve Phase 4 ruleset");
  if (!isDeepStrictEqual(row.config, RULESET_CONFIG)) {
    throw new Error("Existing Phase 4 ruleset config differs from canonical seed");
  }
  return row;
}

async function ensureRelease(
  client: PoolClient,
  rulesetId: string,
): Promise<{ id: string; status: string }> {
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, $3, 'DRAFT', $4)
     ON CONFLICT (release_no) DO NOTHING`,
    [randomUUID(), RELEASE_NO.toString(), RELEASE_NAME, rulesetId],
  );
  const result = await client.query<{
    id: string;
    status: string;
    name: string;
    default_ruleset_id: string;
  }>("SELECT id, status, name, default_ruleset_id FROM content_releases WHERE release_no = $1", [
    RELEASE_NO.toString(),
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("Failed to resolve Phase 4 content release");
  if (row.name !== RELEASE_NAME || row.default_ruleset_id !== rulesetId) {
    throw new Error("Release number 1 is already bound to unexpected content");
  }
  return row;
}

async function ensureIdentities(client: PoolClient): Promise<IdentityMap> {
  const typeSlugs = ["normal", "grass", "poison", "fire", "water", "flying", "electric"] as const;
  const types: Record<string, string> = {};
  for (const slug of typeSlugs)
    types[slug] = await ensureSlugIdentity(client, "pokemon_types", slug);

  const speciesRows = [
    [1, "bulbasaur"],
    [2, "ivysaur"],
    [4, "charmander"],
    [5, "charmeleon"],
    [7, "squirtle"],
    [8, "wartortle"],
    [16, "pidgey"],
    [19, "rattata"],
    [25, "pikachu"],
  ] as const;
  const species: Record<string, string> = {};
  const forms: Record<string, string> = {};
  for (const [dex, slug] of speciesRows) {
    const speciesId = await ensureSpecies(client, dex, slug);
    species[slug] = speciesId;
    forms[slug] = await ensureForm(client, speciesId, "default");
  }

  const moves: Record<string, string> = {};
  for (const slug of [
    "tackle",
    "growl",
    "vine-whip",
    "ember",
    "water-gun",
    "quick-attack",
    "thunder-shock",
    "gust",
  ]) {
    moves[slug] = await ensureSlugIdentity(client, "moves", slug);
  }

  const abilities: Record<string, string> = {};
  for (const slug of ["overgrow", "blaze", "torrent", "keen-eye", "run-away", "static"]) {
    abilities[slug] = await ensureSlugIdentity(client, "abilities", slug);
  }

  const items: Record<string, string> = {};
  for (const slug of ["poke-ball", "potion", "antidote", "paralyze-heal", "ether", "escape-rope"]) {
    items[slug] = await ensureSlugIdentity(client, "items", slug);
  }

  const natures: Record<string, string> = {};
  for (const slug of ["hardy", "adamant", "modest", "timid", "bold", "calm"]) {
    natures[slug] = await ensureSlugIdentity(client, "natures", slug);
  }

  const effects: Record<string, string> = {};
  for (const slug of ["field-potion", "battle-paralysis", "escape-action"]) {
    effects[slug] = await ensureSlugIdentity(client, "effects", slug);
  }

  const regionId = await ensureSlugIdentity(client, "regions", "kanto");
  const areaId = await ensureArea(client, regionId, "route-1");
  const encounterTableId = await ensureEncounterTable(client, areaId, "grass-day");

  return {
    types,
    species,
    forms,
    moves,
    abilities,
    items,
    natures,
    effects,
    regionId,
    areaId,
    encounterTableId,
  };
}

async function seedTypeChart(
  client: PoolClient,
  rulesetId: string,
  types: Readonly<Record<string, string>>,
): Promise<void> {
  const slugs = Object.keys(types).sort();
  const overrides = new Map<string, number>([
    ["grass:water", 20_000],
    ["grass:fire", 5_000],
    ["grass:grass", 5_000],
    ["grass:poison", 5_000],
    ["grass:flying", 5_000],
    ["fire:grass", 20_000],
    ["fire:fire", 5_000],
    ["fire:water", 5_000],
    ["water:fire", 20_000],
    ["water:water", 5_000],
    ["water:grass", 5_000],
    ["electric:water", 20_000],
    ["electric:flying", 20_000],
    ["electric:grass", 5_000],
    ["electric:electric", 5_000],
    ["poison:grass", 20_000],
    ["poison:poison", 5_000],
    ["flying:grass", 20_000],
    ["flying:electric", 5_000],
  ]);
  for (const attacking of slugs) {
    for (const defending of slugs) {
      await client.query(
        `INSERT INTO type_matchups(
           ruleset_id, attacking_type_id, defending_type_id, multiplier_basis_points
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (ruleset_id, attacking_type_id, defending_type_id) DO NOTHING`,
        [
          rulesetId,
          types[attacking],
          types[defending],
          overrides.get(`${attacking}:${defending}`) ?? 10_000,
        ],
      );
    }
  }
}

async function insertRevision(
  client: PoolClient,
  table: string,
  uniqueColumns: readonly string[],
  columns: readonly string[],
  values: readonly unknown[],
): Promise<void> {
  const placeholders = values.map((_, index) => `$${index + 2}`).join(", ");
  await client.query(
    `INSERT INTO ${table}(id, ${columns.join(", ")})
     VALUES ($1, ${placeholders})
     ON CONFLICT (${uniqueColumns.join(", ")}) DO NOTHING`,
    [randomUUID(), ...values],
  );
}

async function seedReleaseContent(
  client: PoolClient,
  releaseId: string,
  ids: IdentityMap,
): Promise<void> {
  const typeNames: Readonly<Record<string, string>> = {
    normal: "Normal",
    grass: "Grass",
    poison: "Poison",
    fire: "Fire",
    water: "Water",
    flying: "Flying",
    electric: "Electric",
  };
  for (const [slug, typeId] of Object.entries(ids.types)) {
    await insertRevision(
      client,
      "pokemon_type_revisions",
      ["content_release_id", "type_id"],
      ["content_release_id", "type_id", "display_name"],
      [releaseId, typeId, typeNames[slug]],
    );
  }

  const speciesData = [
    ["bulbasaur", "Bulbasaur", 45, 64],
    ["ivysaur", "Ivysaur", 45, 142],
    ["charmander", "Charmander", 45, 62],
    ["charmeleon", "Charmeleon", 45, 142],
    ["squirtle", "Squirtle", 45, 63],
    ["wartortle", "Wartortle", 45, 142],
    ["pidgey", "Pidgey", 255, 50],
    ["rattata", "Rattata", 255, 51],
    ["pikachu", "Pikachu", 190, 112],
  ] as const;
  for (const [slug, displayName, catchRate, baseExp] of speciesData) {
    await insertRevision(
      client,
      "pokemon_species_revisions",
      ["content_release_id", "species_id"],
      ["content_release_id", "species_id", "display_name", "catch_rate", "base_exp"],
      [releaseId, ids.species[slug], displayName, catchRate, baseExp],
    );
  }

  const formData = [
    ["bulbasaur", "Bulbasaur", "grass", "poison", 45, 49, 49, 65, 65, 45],
    ["ivysaur", "Ivysaur", "grass", "poison", 60, 62, 63, 80, 80, 60],
    ["charmander", "Charmander", "fire", null, 39, 52, 43, 60, 50, 65],
    ["charmeleon", "Charmeleon", "fire", null, 58, 64, 58, 80, 65, 80],
    ["squirtle", "Squirtle", "water", null, 44, 48, 65, 50, 64, 43],
    ["wartortle", "Wartortle", "water", null, 59, 63, 80, 65, 80, 58],
    ["pidgey", "Pidgey", "normal", "flying", 40, 45, 40, 35, 35, 56],
    ["rattata", "Rattata", "normal", null, 30, 56, 35, 25, 35, 72],
    ["pikachu", "Pikachu", "electric", null, 35, 55, 40, 50, 50, 90],
  ] as const;
  for (const [slug, displayName, type1, type2, hp, atk, def, spa, spd, spe] of formData) {
    await insertRevision(
      client,
      "pokemon_form_revisions",
      ["content_release_id", "form_id"],
      [
        "content_release_id",
        "form_id",
        "display_name",
        "type1_id",
        "type2_id",
        "base_hp",
        "base_attack",
        "base_defense",
        "base_sp_attack",
        "base_sp_defense",
        "base_speed",
      ],
      [
        releaseId,
        ids.forms[slug],
        displayName,
        ids.types[type1],
        type2 === null ? null : ids.types[type2],
        hp,
        atk,
        def,
        spa,
        spd,
        spe,
      ],
    );
  }

  const moveData = [
    ["tackle", "Tackle", "normal", "PHYSICAL", 40, 100, 0, 35, null, {}],
    [
      "growl",
      "Growl",
      "normal",
      "STATUS",
      null,
      100,
      0,
      40,
      "modify-stat-stage",
      { stat: "ATTACK", stages: -1 },
    ],
    ["vine-whip", "Vine Whip", "grass", "PHYSICAL", 45, 100, 0, 25, null, {}],
    [
      "ember",
      "Ember",
      "fire",
      "SPECIAL",
      40,
      100,
      0,
      25,
      "apply-status",
      { status: "BURN", chanceBasisPoints: 1_000 },
    ],
    ["water-gun", "Water Gun", "water", "SPECIAL", 40, 100, 0, 25, null, {}],
    ["quick-attack", "Quick Attack", "normal", "PHYSICAL", 40, 100, 1, 30, null, {}],
    [
      "thunder-shock",
      "Thunder Shock",
      "electric",
      "SPECIAL",
      40,
      100,
      0,
      30,
      "apply-status",
      { status: "PARALYSIS", chanceBasisPoints: 1_000 },
    ],
    ["gust", "Gust", "flying", "SPECIAL", 40, 100, 0, 35, null, {}],
  ] as const;
  for (const [
    slug,
    name,
    type,
    category,
    power,
    accuracy,
    priority,
    maxPp,
    effectKey,
    effectConfig,
  ] of moveData) {
    await insertRevision(
      client,
      "move_revisions",
      ["content_release_id", "move_id"],
      [
        "content_release_id",
        "move_id",
        "display_name",
        "type_id",
        "category",
        "power",
        "accuracy",
        "priority",
        "max_pp",
        "effect_key",
        "effect_config",
      ],
      [
        releaseId,
        ids.moves[slug],
        name,
        ids.types[type],
        category,
        power,
        accuracy,
        priority,
        maxPp,
        effectKey,
        JSON.stringify(effectConfig),
      ],
    );
  }

  const abilityData = [
    [
      "overgrow",
      "Overgrow",
      "low-hp-type-boost",
      { typeSlug: "grass", multiplierBasisPoints: 15_000 },
    ],
    ["blaze", "Blaze", "low-hp-type-boost", { typeSlug: "fire", multiplierBasisPoints: 15_000 }],
    [
      "torrent",
      "Torrent",
      "low-hp-type-boost",
      { typeSlug: "water", multiplierBasisPoints: 15_000 },
    ],
    ["keen-eye", "Keen Eye", "prevent-accuracy-drop", {}],
    ["run-away", "Run Away", "run-away", {}],
    ["static", "Static", "apply-status", { status: "PARALYSIS", chanceBasisPoints: 3_000 }],
  ] as const;
  for (const [slug, name, effectKey, config] of abilityData) {
    await insertRevision(
      client,
      "ability_revisions",
      ["content_release_id", "ability_id"],
      ["content_release_id", "ability_id", "display_name", "effect_key", "effect_config"],
      [releaseId, ids.abilities[slug], name, effectKey, JSON.stringify(config)],
    );
  }

  const itemData = [
    ["poke-ball", "Poké Ball", "BALL", "catch-modifier", { multiplierBasisPoints: 10_000 }],
    ["potion", "Potion", "MEDICINE", "heal-hp", { amount: 20 }],
    ["antidote", "Antidote", "MEDICINE", "cure-status", { status: "POISON" }],
    ["paralyze-heal", "Paralyze Heal", "MEDICINE", "cure-status", { status: "PARALYSIS" }],
    ["ether", "Ether", "MEDICINE", "restore-pp", { amount: 10 }],
    ["escape-rope", "Escape Rope", "FIELD", "run-away", {}],
  ] as const;
  for (const [slug, name, kind, effectKey, config] of itemData) {
    await insertRevision(
      client,
      "item_revisions",
      ["content_release_id", "item_id"],
      ["content_release_id", "item_id", "display_name", "item_kind", "effect_key", "effect_config"],
      [releaseId, ids.items[slug], name, kind, effectKey, JSON.stringify(config)],
    );
  }

  const natureData = [
    ["hardy", "Hardy", null, null],
    ["adamant", "Adamant", "ATTACK", "SP_ATTACK"],
    ["modest", "Modest", "SP_ATTACK", "ATTACK"],
    ["timid", "Timid", "SPEED", "ATTACK"],
    ["bold", "Bold", "DEFENSE", "ATTACK"],
    ["calm", "Calm", "SP_DEFENSE", "ATTACK"],
  ] as const;
  for (const [slug, name, increased, decreased] of natureData) {
    await insertRevision(
      client,
      "nature_revisions",
      ["content_release_id", "nature_id"],
      ["content_release_id", "nature_id", "display_name", "increased_stat", "decreased_stat"],
      [releaseId, ids.natures[slug], name, increased, decreased],
    );
  }

  const effectData = [
    [
      "field-potion",
      "POKEMON",
      "REFRESH",
      "INSTANT",
      { version: 1, steps: [{ effectKey: "heal-hp", config: { amount: 20 } }] },
    ],
    [
      "battle-paralysis",
      "BATTLE_PARTICIPANT",
      "REFRESH",
      "BATTLE",
      {
        version: 1,
        steps: [
          { effectKey: "apply-status", config: { status: "PARALYSIS", chanceBasisPoints: 3_000 } },
        ],
      },
    ],
    [
      "escape-action",
      "PLAYER",
      "REFRESH",
      "INSTANT",
      { version: 1, steps: [{ effectKey: "run-away", config: {} }] },
    ],
  ] as const;
  for (const [slug, scope, stacking, duration, rules] of effectData) {
    await insertRevision(
      client,
      "effect_revisions",
      ["content_release_id", "effect_id"],
      ["content_release_id", "effect_id", "scope", "stacking_policy", "duration_model", "rules"],
      [releaseId, ids.effects[slug], scope, stacking, duration, JSON.stringify(rules)],
    );
  }

  await insertRevision(
    client,
    "region_revisions",
    ["content_release_id", "region_id"],
    ["content_release_id", "region_id", "display_name"],
    [releaseId, ids.regionId, "Kanto"],
  );
  await insertRevision(
    client,
    "area_revisions",
    ["content_release_id", "area_id"],
    ["content_release_id", "area_id", "display_name"],
    [releaseId, ids.areaId, "Route 1"],
  );

  const abilityByForm: Readonly<Record<string, string>> = {
    bulbasaur: "overgrow",
    ivysaur: "overgrow",
    charmander: "blaze",
    charmeleon: "blaze",
    squirtle: "torrent",
    wartortle: "torrent",
    pidgey: "keen-eye",
    rattata: "run-away",
    pikachu: "static",
  };
  for (const [formSlug, abilitySlug] of Object.entries(abilityByForm)) {
    await insertRevision(
      client,
      "pokemon_form_ability_options",
      ["content_release_id", "form_id", "ability_id", "slot_kind"],
      ["content_release_id", "form_id", "ability_id", "slot_kind"],
      [releaseId, ids.forms[formSlug], ids.abilities[abilitySlug], "PRIMARY"],
    );
  }

  const learnsets: readonly [string, string, string, number | null][] = [
    ["bulbasaur", "tackle", "START", null],
    ["bulbasaur", "growl", "START", null],
    ["bulbasaur", "vine-whip", "LEVEL", 7],
    ["ivysaur", "tackle", "START", null],
    ["ivysaur", "vine-whip", "START", null],
    ["charmander", "tackle", "START", null],
    ["charmander", "growl", "START", null],
    ["charmander", "ember", "LEVEL", 7],
    ["charmeleon", "tackle", "START", null],
    ["charmeleon", "ember", "START", null],
    ["squirtle", "tackle", "START", null],
    ["squirtle", "growl", "START", null],
    ["squirtle", "water-gun", "LEVEL", 7],
    ["wartortle", "tackle", "START", null],
    ["wartortle", "water-gun", "START", null],
    ["pidgey", "tackle", "START", null],
    ["pidgey", "gust", "LEVEL", 5],
    ["rattata", "tackle", "START", null],
    ["rattata", "quick-attack", "LEVEL", 7],
    ["pikachu", "thunder-shock", "START", null],
    ["pikachu", "growl", "START", null],
    ["pikachu", "quick-attack", "LEVEL", 7],
  ];
  for (const [formSlug, moveSlug, method, level] of learnsets) {
    await insertRevision(
      client,
      "move_learnset_entries",
      ["content_release_id", "form_id", "move_id", "learn_method", "learn_level"],
      ["content_release_id", "form_id", "move_id", "learn_method", "learn_level"],
      [releaseId, ids.forms[formSlug], ids.moves[moveSlug], method, level],
    );
  }

  for (const [from, to] of [
    ["bulbasaur", "ivysaur"],
    ["charmander", "charmeleon"],
    ["squirtle", "wartortle"],
  ] as const) {
    await insertRevision(
      client,
      "evolution_rules",
      ["content_release_id", "from_form_id", "to_form_id", "trigger_kind"],
      ["content_release_id", "from_form_id", "to_form_id", "trigger_kind", "trigger_config"],
      [releaseId, ids.forms[from], ids.forms[to], "LEVEL", JSON.stringify({ level: 16 })],
    );
  }

  const encounterRevisionId = randomUUID();
  await client.query(
    `INSERT INTO encounter_table_revisions(id, content_release_id, encounter_table_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (content_release_id, encounter_table_id) DO NOTHING`,
    [encounterRevisionId, releaseId, ids.encounterTableId],
  );
  const resolvedEncounterRevision = await client.query<{ id: string }>(
    `SELECT id FROM encounter_table_revisions
     WHERE content_release_id = $1 AND encounter_table_id = $2`,
    [releaseId, ids.encounterTableId],
  );
  const encounterTableRevisionId = resolvedEncounterRevision.rows[0]?.id;
  if (encounterTableRevisionId === undefined)
    throw new Error("Failed to resolve encounter revision");

  for (const [formSlug, weight, minLevel, maxLevel] of [
    ["pidgey", 50, 2, 4],
    ["rattata", 40, 2, 4],
    ["pikachu", 10, 3, 5],
  ] as const) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM encounter_entries
       WHERE encounter_table_revision_id = $1 AND form_id = $2`,
      [encounterTableRevisionId, ids.forms[formSlug]],
    );
    if (existing.rows[0] === undefined) {
      await client.query(
        `INSERT INTO encounter_entries(
           id, encounter_table_revision_id, form_id, weight, min_level, max_level
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), encounterTableRevisionId, ids.forms[formSlug], weight, minLevel, maxLevel],
      );
    }
  }
}

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const migrations = await loadMigrations();
    const verifyClient = await pool.connect();
    try {
      await verifyAppliedMigrations(verifyClient, migrations, true);
    } finally {
      verifyClient.release();
    }

    const prepared = await withTransaction(pool, async (client) => {
      const ruleset = await ensureRuleset(client);
      const release = await ensureRelease(client, ruleset.id);
      if (
        release.status !== "DRAFT" &&
        release.status !== "VALIDATED" &&
        release.status !== "PUBLISHED"
      ) {
        throw new Error(`Vertical-slice release is not seedable from status ${release.status}`);
      }
      const ids = await ensureIdentities(client);
      if (ruleset.status === "DRAFT") await seedTypeChart(client, ruleset.id, ids.types);
      if (release.status === "DRAFT") await seedReleaseContent(client, release.id, ids);
      return { ruleset, release };
    });

    const service = new CatalogService(new PostgresCatalogRepository(pool));
    if (prepared.ruleset.status === "DRAFT") {
      unwrap("validate ruleset", await service.validateRuleset(prepared.ruleset.id));
      unwrap("publish ruleset", await service.publishRuleset(prepared.ruleset.id));
    } else if (prepared.ruleset.status === "VALIDATED") {
      unwrap("publish ruleset", await service.publishRuleset(prepared.ruleset.id));
    }

    if (prepared.release.status === "DRAFT") {
      unwrap("validate release", await service.validateRelease(prepared.release.id));
      unwrap("publish release", await service.publishRelease(prepared.release.id));
    } else if (prepared.release.status === "VALIDATED") {
      unwrap("publish release", await service.publishRelease(prepared.release.id));
    }
    unwrap("activate release", await service.activateRelease(prepared.release.id));

    console.log(`Phase 4 vertical slice ready: release ${prepared.release.id}`);
  } finally {
    await pool.end();
  }
}

await main();
