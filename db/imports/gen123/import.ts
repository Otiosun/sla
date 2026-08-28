import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { gen123Id, titleize } from "./ids.js";
import { type Gen123Model, loadGen123Model } from "./model.js";
import {
  type CsvRow,
  GEN123_SOURCE,
  Gen123Source,
  requiredInt,
  requiredText,
  sourceMetadata,
} from "./source.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is required for Gen I-III import");

const RULESET_KEY = "gen123-core";
const RULESET_VERSION = 1;
const RELEASE_NO = 15001n;
const RELEASE_NAME = "Gen I-III production candidate v1";

interface IdentityMaps {
  readonly type: ReadonlyMap<number, string>;
  readonly species: ReadonlyMap<number, string>;
  readonly form: ReadonlyMap<number, string>;
  readonly move: ReadonlyMap<number, string>;
  readonly ability: ReadonlyMap<number, string>;
  readonly item: ReadonlyMap<number, string>;
  readonly nature: ReadonlyMap<number, string>;
  readonly region: ReadonlyMap<number, string>;
  readonly area: ReadonlyMap<number, string>;
  readonly encounterTable: ReadonlyMap<number, string>;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function chunks<T>(values: readonly T[], size = 300): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  conflict: string,
): Promise<void> {
  for (const batch of chunks(rows)) {
    if (batch.length === 0) continue;
    const values: unknown[] = [];
    const tuples = batch.map((row, rowIndex) => {
      if (row.length !== columns.length) throw new Error(`${table}: column/value mismatch`);
      const offset = rowIndex * columns.length;
      for (const value of row) values.push(value);
      return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflict}`,
      values,
    );
  }
}

async function slugMap(
  client: PoolClient,
  table: string,
  source: readonly CsvRow[],
): Promise<Map<number, string>> {
  const slugs = source.map((row) => requiredText(row, "identifier"));
  const result = await client.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM ${table} WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const idBySlug = new Map(result.rows.map((row) => [row.slug, row.id] as const));
  return new Map(
    source.map((row) => {
      const sourceId = requiredInt(row, "id");
      const slug = requiredText(row, "identifier");
      const id = idBySlug.get(slug);
      if (id === undefined) throw new Error(`Missing ${table} identity for ${slug}`);
      return [sourceId, id] as const;
    }),
  );
}

async function ensureRuleset(client: PoolClient, model: Gen123Model): Promise<string> {
  const existing = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM rulesets WHERE key = $1 AND version = $2",
    [RULESET_KEY, RULESET_VERSION],
  );
  if (
    existing.rows[0] !== undefined &&
    new Set(["VALIDATED", "PUBLISHED"]).has(existing.rows[0].status)
  ) {
    return existing.rows[0].id;
  }

  const base = await client.query<{
    config: unknown;
    engine_contract_version: number;
  }>(
    `SELECT ruleset.config, ruleset.engine_contract_version
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id = pointer.content_release_id
     JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
     WHERE pointer.pointer_key = 'ACTIVE'`,
  );
  const baseRow = base.rows[0];
  if (baseRow === undefined)
    throw new Error("Active ruleset is required as engine-compatible config baseline");
  const id = existing.rows[0]?.id ?? gen123Id("ruleset:gen123-core-v1");
  if (existing.rows.length === 0) {
    await client.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'DRAFT')`,
      [
        id,
        RULESET_KEY,
        RULESET_VERSION,
        baseRow.engine_contract_version,
        JSON.stringify(baseRow.config),
      ],
    );
  }

  const typeRows = model.typeRows;
  await insertRows(
    client,
    "pokemon_types",
    ["id", "slug"],
    typeRows.map((row) => [
      gen123Id(`type:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const typeMap = await slugMap(client, "pokemon_types", typeRows);
  const efficacy = new Map(
    model.typeEfficacyRows.map(
      (row) =>
        [
          `${requiredInt(row, "damage_type_id")}:${requiredInt(row, "target_type_id")}`,
          requiredInt(row, "damage_factor"),
        ] as const,
    ),
  );
  const matchups: (readonly unknown[])[] = [];
  for (const attacking of typeRows) {
    for (const defending of typeRows) {
      const attackSource = requiredInt(attacking, "id");
      const defendSource = requiredInt(defending, "id");
      matchups.push([
        id,
        typeMap.get(attackSource),
        typeMap.get(defendSource),
        (efficacy.get(`${attackSource}:${defendSource}`) ?? 100) * 100,
      ]);
    }
  }
  await insertRows(
    client,
    "type_matchups",
    ["ruleset_id", "attacking_type_id", "defending_type_id", "multiplier_basis_points"],
    matchups,
    "ON CONFLICT (ruleset_id, attacking_type_id, defending_type_id) DO UPDATE SET multiplier_basis_points = EXCLUDED.multiplier_basis_points",
  );

  const report = {
    phase: 15,
    scope: "GEN_1_3",
    source: sourceMetadata(),
    typeCount: typeRows.length,
    chartCells: matchups.length,
  };
  await client.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = now(), validation_report = $2::jsonb,
         config_fingerprint = $3
     WHERE id = $1 AND status = 'DRAFT'`,
    [id, JSON.stringify(report), fingerprint(baseRow.config)],
  );
  return id;
}

async function ensureRelease(
  client: PoolClient,
  rulesetId: string,
): Promise<{ id: string; status: string }> {
  const id = gen123Id("release:gen123-production-candidate-v1");
  const existing = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM content_releases WHERE id = $1",
    [id],
  );
  if (existing.rows[0] !== undefined) return existing.rows[0];
  const active = await client.query<{ content_release_id: string }>(
    "SELECT content_release_id FROM content_release_pointers WHERE pointer_key = 'ACTIVE'",
  );
  const parent = active.rows[0]?.content_release_id ?? null;
  await client.query(
    `INSERT INTO content_releases(
       id, release_no, name, status, parent_release_id, default_ruleset_id
     ) VALUES ($1, $2, $3, 'DRAFT', $4, $5)`,
    [id, RELEASE_NO.toString(), RELEASE_NAME, parent, rulesetId],
  );
  return { id, status: "DRAFT" };
}

async function ensureIdentities(
  client: PoolClient,
  model: Gen123Model,
): Promise<Omit<IdentityMaps, "encounterTable">> {
  await insertRows(
    client,
    "pokemon_types",
    ["id", "slug"],
    model.typeRows.map((row) => [
      gen123Id(`type:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const type = await slugMap(client, "pokemon_types", model.typeRows);

  await insertRows(
    client,
    "pokemon_species",
    ["id", "national_dex", "slug"],
    model.species.map((species) => [
      gen123Id(`species:${species.sourceSpeciesId}`),
      species.sourceSpeciesId,
      species.slug,
    ]),
    "ON CONFLICT DO NOTHING",
  );
  const speciesRows = await client.query<{ id: string; national_dex: number }>(
    "SELECT id, national_dex FROM pokemon_species WHERE national_dex BETWEEN 1 AND 386",
  );
  const species = new Map(speciesRows.rows.map((row) => [row.national_dex, row.id] as const));
  if (species.size !== 386)
    throw new Error(`Identity import expected 386 species, found ${species.size}`);

  await insertRows(
    client,
    "pokemon_forms",
    ["id", "species_id", "slug"],
    model.species.map((entry) => [
      gen123Id(`form:${entry.sourceSpeciesId}:default`),
      species.get(entry.sourceSpeciesId),
      entry.slug,
    ]),
    "ON CONFLICT (species_id, slug) DO NOTHING",
  );
  const formRows = await client.query<{ id: string; national_dex: number }>(
    `SELECT form.id, species.national_dex
     FROM pokemon_forms form
     JOIN pokemon_species species ON species.id = form.species_id
     WHERE species.national_dex BETWEEN 1 AND 386
       AND form.slug = species.slug`,
  );
  const form = new Map(formRows.rows.map((row) => [row.national_dex, row.id] as const));
  if (form.size !== 386)
    throw new Error(`Default form import expected 386 forms, found ${form.size}`);

  const moveSourceRows: CsvRow[] = model.moves.map((entry) => ({
    id: String(entry.sourceId),
    identifier: entry.slug,
  }));
  await insertRows(
    client,
    "moves",
    ["id", "slug"],
    moveSourceRows.map((row) => [
      gen123Id(`move:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const move = await slugMap(client, "moves", moveSourceRows);

  await insertRows(
    client,
    "abilities",
    ["id", "slug"],
    model.abilityRows.map((row) => [
      gen123Id(`ability:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const ability = await slugMap(client, "abilities", model.abilityRows);

  const requiredItems = model.itemRows.filter((row) =>
    model.requiredItemIds.has(requiredInt(row, "id")),
  );
  await insertRows(
    client,
    "items",
    ["id", "slug"],
    requiredItems.map((row) => [
      gen123Id(`item:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const item = await slugMap(client, "items", requiredItems);

  await insertRows(
    client,
    "natures",
    ["id", "slug"],
    model.natureRows.map((row) => [
      gen123Id(`nature:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const nature = await slugMap(client, "natures", model.natureRows);

  await insertRows(
    client,
    "regions",
    ["id", "slug"],
    model.regionRows.map((row) => [
      gen123Id(`region:${requiredInt(row, "id")}`),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (slug) DO NOTHING",
  );
  const region = await slugMap(client, "regions", model.regionRows);

  await insertRows(
    client,
    "areas",
    ["id", "region_id", "slug"],
    model.locationRows.map((row) => [
      gen123Id(`area:location:${requiredInt(row, "id")}`),
      region.get(requiredInt(row, "region_id")),
      requiredText(row, "identifier"),
    ]),
    "ON CONFLICT (region_id, slug) DO NOTHING",
  );
  const areaRows = await client.query<{ id: string; source_region: number; slug: string }>(
    `SELECT area.id, CASE region.slug WHEN 'kanto' THEN 1 WHEN 'johto' THEN 2 WHEN 'hoenn' THEN 3 END AS source_region,
            area.slug
     FROM areas area JOIN regions region ON region.id = area.region_id
     WHERE region.slug IN ('kanto','johto','hoenn')`,
  );
  const areaByRegionSlug = new Map(
    areaRows.rows.map((row) => [`${row.source_region}:${row.slug}`, row.id] as const),
  );
  const area = new Map(
    model.locationRows.map((row) => {
      const sourceId = requiredInt(row, "id");
      const id = areaByRegionSlug.get(
        `${requiredInt(row, "region_id")}:${requiredText(row, "identifier")}`,
      );
      if (id === undefined) throw new Error(`Missing imported area ${sourceId}`);
      return [sourceId, id] as const;
    }),
  );

  return { type, species, form, move, ability, item, nature, region, area };
}

function category(damageClassId: number): "STATUS" | "PHYSICAL" | "SPECIAL" {
  if (damageClassId === 1) return "STATUS";
  if (damageClassId === 2) return "PHYSICAL";
  return "SPECIAL";
}

function natureStat(id: number): "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED" {
  const map = new Map<number, "ATTACK" | "DEFENSE" | "SP_ATTACK" | "SP_DEFENSE" | "SPEED">([
    [2, "ATTACK"],
    [3, "DEFENSE"],
    [4, "SP_ATTACK"],
    [5, "SP_DEFENSE"],
    [6, "SPEED"],
  ]);
  const value = map.get(id);
  if (value === undefined) throw new Error(`Unsupported nature stat id ${id}`);
  return value;
}

function learnMethod(
  methodId: number,
  level: number,
): { method: string; level: number | null; source: string } {
  if (methodId === 1)
    return level === 0
      ? { method: "START", level: null, source: "level-up:0" }
      : { method: "LEVEL", level, source: "level-up" };
  if (methodId === 3) return { method: "TUTOR", level: null, source: "tutor" };
  if (methodId === 4) return { method: "TM", level: null, source: "machine" };
  return { method: "EVENT", level: null, source: methodId === 2 ? "egg" : `method:${methodId}` };
}

function evolutionRule(evolution: Gen123Model["evolutions"][number]): {
  trigger: "LEVEL" | "ITEM" | "CONDITION";
  supported: boolean;
  config: Readonly<Record<string, unknown>>;
} {
  const extraConditions = Object.keys(evolution.config).length > 0;
  if (evolution.triggerId === 1 && evolution.minimumLevel !== null && !extraConditions) {
    return { trigger: "LEVEL", supported: true, config: { minimumLevel: evolution.minimumLevel } };
  }
  if (evolution.triggerId === 3 && evolution.itemId !== null && !extraConditions) {
    return { trigger: "ITEM", supported: true, config: { sourceItemId: evolution.itemId } };
  }
  return {
    trigger: "CONDITION",
    supported: false,
    config: {
      sourceTriggerId: evolution.triggerId,
      sourceItemId: evolution.itemId,
      minimumLevel: evolution.minimumLevel,
      ...evolution.config,
      mechanicsSupport: "UNSUPPORTED_IN_V1",
    },
  };
}

async function importReleaseChildren(
  client: PoolClient,
  releaseId: string,
  model: Gen123Model,
  ids: Omit<IdentityMaps, "encounterTable">,
): Promise<IdentityMaps> {
  const metadata = sourceMetadata({ scope: "GEN_1_3" });
  await insertRows(
    client,
    "pokemon_type_revisions",
    ["id", "content_release_id", "type_id", "display_name", "active", "data"],
    model.typeRows.map((row) => [
      gen123Id(`rev:${releaseId}:type:${requiredInt(row, "id")}`),
      releaseId,
      ids.type.get(requiredInt(row, "id")),
      titleize(requiredText(row, "identifier")),
      true,
      JSON.stringify(metadata),
    ]),
    "ON CONFLICT (content_release_id, type_id) DO UPDATE SET display_name=EXCLUDED.display_name, active=EXCLUDED.active, data=EXCLUDED.data",
  );

  await insertRows(
    client,
    "pokemon_species_revisions",
    [
      "id",
      "content_release_id",
      "species_id",
      "display_name",
      "catch_rate",
      "base_exp",
      "active",
      "data",
    ],
    model.species.map((entry) => [
      gen123Id(`rev:${releaseId}:species:${entry.sourceSpeciesId}`),
      releaseId,
      ids.species.get(entry.sourceSpeciesId),
      titleize(entry.slug),
      entry.captureRate,
      entry.baseExperience,
      true,
      JSON.stringify(
        sourceMetadata({
          generationId: entry.generationId,
          genderRate: entry.genderRate,
          height: entry.height,
          weight: entry.weight,
        }),
      ),
    ]),
    "ON CONFLICT (content_release_id, species_id) DO UPDATE SET display_name=EXCLUDED.display_name, catch_rate=EXCLUDED.catch_rate, base_exp=EXCLUDED.base_exp, active=EXCLUDED.active, data=EXCLUDED.data",
  );

  await insertRows(
    client,
    "pokemon_form_revisions",
    [
      "id",
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
      "active",
      "data",
    ],
    model.species.map((entry) => [
      gen123Id(`rev:${releaseId}:form:${entry.sourceSpeciesId}`),
      releaseId,
      ids.form.get(entry.sourceSpeciesId),
      titleize(entry.slug),
      ids.type.get(entry.typeIds[0] ?? -1),
      entry.typeIds[1] === undefined ? null : ids.type.get(entry.typeIds[1]),
      ...entry.stats,
      true,
      JSON.stringify(sourceMetadata({ requiredFormScope: "DEFAULT_FORM" })),
    ]),
    "ON CONFLICT (content_release_id, form_id) DO UPDATE SET display_name=EXCLUDED.display_name,type1_id=EXCLUDED.type1_id,type2_id=EXCLUDED.type2_id,base_hp=EXCLUDED.base_hp,base_attack=EXCLUDED.base_attack,base_defense=EXCLUDED.base_defense,base_sp_attack=EXCLUDED.base_sp_attack,base_sp_defense=EXCLUDED.base_sp_defense,base_speed=EXCLUDED.base_speed,active=EXCLUDED.active,data=EXCLUDED.data",
  );

  await insertRows(
    client,
    "move_revisions",
    [
      "id",
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
      "active",
    ],
    model.moves.map((move) => [
      gen123Id(`rev:${releaseId}:move:${move.sourceId}`),
      releaseId,
      ids.move.get(move.sourceId),
      titleize(move.slug),
      ids.type.get(move.typeId),
      category(move.damageClassId),
      move.power,
      move.accuracy,
      move.priority,
      move.pp,
      null,
      JSON.stringify(
        sourceMetadata({
          sourceEffectId: move.effectId,
          effectChance: move.effectChance,
          mechanicsSupport: "DATA_IMPORTED_EFFECT_UNIMPLEMENTED_UNLESS_ENGINE_KEYED",
        }),
      ),
      true,
    ]),
    "ON CONFLICT (content_release_id, move_id) DO UPDATE SET display_name=EXCLUDED.display_name,type_id=EXCLUDED.type_id,category=EXCLUDED.category,power=EXCLUDED.power,accuracy=EXCLUDED.accuracy,priority=EXCLUDED.priority,max_pp=EXCLUDED.max_pp,effect_key=EXCLUDED.effect_key,effect_config=EXCLUDED.effect_config,active=EXCLUDED.active",
  );

  await insertRows(
    client,
    "ability_revisions",
    [
      "id",
      "content_release_id",
      "ability_id",
      "display_name",
      "effect_key",
      "effect_config",
      "active",
    ],
    model.abilityRows.map((row) => [
      gen123Id(`rev:${releaseId}:ability:${requiredInt(row, "id")}`),
      releaseId,
      ids.ability.get(requiredInt(row, "id")),
      titleize(requiredText(row, "identifier")),
      null,
      JSON.stringify(sourceMetadata({ mechanicsSupport: "UNSUPPORTED_IN_V1" })),
      true,
    ]),
    "ON CONFLICT (content_release_id, ability_id) DO UPDATE SET display_name=EXCLUDED.display_name,effect_key=EXCLUDED.effect_key,effect_config=EXCLUDED.effect_config,active=EXCLUDED.active",
  );

  const requiredItems = model.itemRows.filter((row) =>
    model.requiredItemIds.has(requiredInt(row, "id")),
  );
  const ballSlugs = new Set(["poke-ball", "great-ball", "ultra-ball", "master-ball"]);
  const medicineSlugs = new Set([
    "potion",
    "super-potion",
    "hyper-potion",
    "max-potion",
    "full-restore",
    "antidote",
    "burn-heal",
    "ice-heal",
    "awakening",
    "paralyze-heal",
    "full-heal",
    "revive",
    "max-revive",
    "ether",
    "max-ether",
    "elixir",
    "max-elixir",
  ]);
  await insertRows(
    client,
    "item_revisions",
    [
      "id",
      "content_release_id",
      "item_id",
      "display_name",
      "item_kind",
      "effect_key",
      "effect_config",
      "active",
    ],
    requiredItems.map((row) => {
      const slug = requiredText(row, "identifier");
      return [
        gen123Id(`rev:${releaseId}:item:${requiredInt(row, "id")}`),
        releaseId,
        ids.item.get(requiredInt(row, "id")),
        titleize(slug),
        ballSlugs.has(slug) ? "POKE_BALL" : medicineSlugs.has(slug) ? "MEDICINE" : "GENERAL",
        null,
        JSON.stringify(sourceMetadata({ mechanicsSupport: "CATALOG_ONLY_UNLESS_ENGINE_KEYED" })),
        true,
      ];
    }),
    "ON CONFLICT (content_release_id, item_id) DO UPDATE SET display_name=EXCLUDED.display_name,item_kind=EXCLUDED.item_kind,effect_key=EXCLUDED.effect_key,effect_config=EXCLUDED.effect_config,active=EXCLUDED.active",
  );

  await insertRows(
    client,
    "nature_revisions",
    [
      "id",
      "content_release_id",
      "nature_id",
      "display_name",
      "increased_stat",
      "decreased_stat",
      "active",
    ],
    model.natureRows.map((row) => {
      const increased = requiredInt(row, "increased_stat_id");
      const decreased = requiredInt(row, "decreased_stat_id");
      const neutral = increased === decreased;
      return [
        gen123Id(`rev:${releaseId}:nature:${requiredInt(row, "id")}`),
        releaseId,
        ids.nature.get(requiredInt(row, "id")),
        titleize(requiredText(row, "identifier")),
        neutral ? null : natureStat(increased),
        neutral ? null : natureStat(decreased),
        true,
      ];
    }),
    "ON CONFLICT (content_release_id, nature_id) DO UPDATE SET display_name=EXCLUDED.display_name,increased_stat=EXCLUDED.increased_stat,decreased_stat=EXCLUDED.decreased_stat,active=EXCLUDED.active",
  );

  await insertRows(
    client,
    "region_revisions",
    ["id", "content_release_id", "region_id", "display_name", "active", "data"],
    model.regionRows.map((row) => [
      gen123Id(`rev:${releaseId}:region:${requiredInt(row, "id")}`),
      releaseId,
      ids.region.get(requiredInt(row, "id")),
      titleize(requiredText(row, "identifier")),
      true,
      JSON.stringify(metadata),
    ]),
    "ON CONFLICT (content_release_id, region_id) DO UPDATE SET display_name=EXCLUDED.display_name,active=EXCLUDED.active,data=EXCLUDED.data",
  );

  const initialSlugs = new Set(["pallet-town", "new-bark-town", "littleroot-town"]);
  await insertRows(
    client,
    "area_revisions",
    ["id", "content_release_id", "area_id", "display_name", "active", "data"],
    model.locationRows.map((row) => {
      const slug = requiredText(row, "identifier");
      return [
        gen123Id(`rev:${releaseId}:area:${requiredInt(row, "id")}`),
        releaseId,
        ids.area.get(requiredInt(row, "id")),
        titleize(slug),
        true,
        JSON.stringify(
          sourceMetadata({
            sourceLocationId: requiredInt(row, "id"),
            initialArea: initialSlugs.has(slug),
            connectionCoverage: "BLOCKED_PENDING_CANONICAL_GRAPH",
          }),
        ),
      ];
    }),
    "ON CONFLICT (content_release_id, area_id) DO UPDATE SET display_name=EXCLUDED.display_name,active=EXCLUDED.active,data=EXCLUDED.data",
  );

  const abilityOptionRows: (readonly unknown[])[] = [];
  for (const entry of model.species)
    for (const slot of entry.abilitySlots) {
      const abilityId = ids.ability.get(slot.abilityId);
      if (abilityId === undefined) continue;
      abilityOptionRows.push([
        gen123Id(
          `ability-option:${releaseId}:${entry.sourceSpeciesId}:${slot.abilityId}:${slot.slot}`,
        ),
        releaseId,
        ids.form.get(entry.sourceSpeciesId),
        abilityId,
        slot.hidden ? "HIDDEN" : slot.slot === 1 ? "PRIMARY" : "SECONDARY",
        true,
      ]);
    }
  await insertRows(
    client,
    "pokemon_form_ability_options",
    ["id", "content_release_id", "form_id", "ability_id", "slot_kind", "active"],
    abilityOptionRows,
    "ON CONFLICT (content_release_id, form_id, ability_id, slot_kind) DO UPDATE SET active=EXCLUDED.active",
  );

  const learnsetRows = model.learnsets.map((entry) => {
    const mapped = learnMethod(entry.methodId, entry.level);
    return [
      gen123Id(
        `learnset:${releaseId}:${entry.speciesId}:${entry.moveId}:${mapped.method}:${mapped.level ?? "x"}`,
      ),
      releaseId,
      ids.form.get(entry.speciesId),
      ids.move.get(entry.moveId),
      mapped.method,
      mapped.level,
      `${mapped.source};version-groups=${entry.versionGroupIds.join("|")}`,
      true,
    ] as const;
  });
  await insertRows(
    client,
    "move_learnset_entries",
    [
      "id",
      "content_release_id",
      "form_id",
      "move_id",
      "learn_method",
      "learn_level",
      "source_key",
      "active",
    ],
    learnsetRows,
    "ON CONFLICT (content_release_id, form_id, move_id, learn_method, learn_level) DO UPDATE SET source_key=EXCLUDED.source_key,active=EXCLUDED.active",
  );

  const evolutionRows = model.evolutions.map((evolution) => {
    const rule = evolutionRule(evolution);
    const sourceItemIdentity =
      evolution.itemId === null ? null : (ids.item.get(evolution.itemId) ?? null);
    return [
      gen123Id(
        `evolution:${releaseId}:${evolution.fromSpeciesId}:${evolution.toSpeciesId}:${evolution.triggerId}`,
      ),
      releaseId,
      ids.form.get(evolution.fromSpeciesId),
      ids.form.get(evolution.toSpeciesId),
      rule.trigger,
      JSON.stringify({
        ...rule.config,
        sourceItemIdentityId: sourceItemIdentity,
        source: sourceMetadata(),
      }),
      rule.supported,
    ] as const;
  });
  await insertRows(
    client,
    "evolution_rules",
    [
      "id",
      "content_release_id",
      "from_form_id",
      "to_form_id",
      "trigger_kind",
      "trigger_config",
      "active",
    ],
    evolutionRows,
    "ON CONFLICT (content_release_id, from_form_id, to_form_id, trigger_kind) DO UPDATE SET trigger_config=EXCLUDED.trigger_config,active=EXCLUDED.active",
  );

  const starterSpecies = new Map<number, readonly number[]>([
    [1, [1, 4, 7]],
    [2, [152, 155, 158]],
    [3, [252, 255, 258]],
  ]);
  const starters: (readonly unknown[])[] = [];
  for (const [regionSource, speciesIds] of starterSpecies) {
    for (const [index, speciesSource] of speciesIds.entries()) {
      starters.push([
        gen123Id(`starter:${releaseId}:${regionSource}:${speciesSource}`),
        releaseId,
        ids.region.get(regionSource),
        ids.form.get(speciesSource),
        5,
        index,
        true,
      ]);
    }
  }
  await insertRows(
    client,
    "starter_options",
    ["id", "content_release_id", "region_id", "form_id", "starter_level", "sort_order", "active"],
    starters,
    "ON CONFLICT (content_release_id, region_id, form_id) DO UPDATE SET starter_level=EXCLUDED.starter_level,sort_order=EXCLUDED.sort_order,active=EXCLUDED.active",
  );

  const locationIdsWithEncounters = [...new Set(model.encounters.map((entry) => entry.locationId))];
  await insertRows(
    client,
    "encounter_tables",
    ["id", "area_id", "slug"],
    locationIdsWithEncounters.map((locationId) => [
      gen123Id(`encounter-table:${locationId}:wild`),
      ids.area.get(locationId),
      "wild",
    ]),
    "ON CONFLICT (area_id, slug) DO NOTHING",
  );
  const tableRows = await client.query<{ id: string; area_id: string }>(
    "SELECT id, area_id FROM encounter_tables WHERE slug='wild' AND area_id = ANY($1::uuid[])",
    [[...ids.area.values()]],
  );
  const tableByArea = new Map(tableRows.rows.map((row) => [row.area_id, row.id] as const));
  const encounterTable = new Map(
    locationIdsWithEncounters.map((locationId) => {
      const areaId = ids.area.get(locationId);
      const tableId = areaId === undefined ? undefined : tableByArea.get(areaId);
      if (tableId === undefined)
        throw new Error(`Missing encounter table for location ${locationId}`);
      return [locationId, tableId] as const;
    }),
  );
  await insertRows(
    client,
    "encounter_table_revisions",
    ["id", "content_release_id", "encounter_table_id", "active", "conditions"],
    locationIdsWithEncounters.map((locationId) => [
      gen123Id(`encounter-table-rev:${releaseId}:${locationId}`),
      releaseId,
      encounterTable.get(locationId),
      true,
      JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [], blockedUnlockKeys: [] }),
    ]),
    "ON CONFLICT (content_release_id, encounter_table_id) DO UPDATE SET active=EXCLUDED.active,conditions=EXCLUDED.conditions",
  );
  const revRows = await client.query<{ id: string; encounter_table_id: string }>(
    "SELECT id, encounter_table_id FROM encounter_table_revisions WHERE content_release_id=$1",
    [releaseId],
  );
  const revisionByTable = new Map(
    revRows.rows.map((row) => [row.encounter_table_id, row.id] as const),
  );
  await client.query(
    "DELETE FROM encounter_entries WHERE encounter_table_revision_id = ANY($1::uuid[])",
    [[...revisionByTable.values()]],
  );
  await insertRows(
    client,
    "encounter_entries",
    [
      "id",
      "encounter_table_revision_id",
      "form_id",
      "weight",
      "min_level",
      "max_level",
      "active",
      "conditions",
    ],
    model.encounters.map((entry) => {
      const tableId = encounterTable.get(entry.locationId);
      const revisionId = tableId === undefined ? undefined : revisionByTable.get(tableId);
      if (revisionId === undefined)
        throw new Error(`Missing encounter revision ${entry.locationId}`);
      return [
        gen123Id(
          `encounter:${releaseId}:${entry.locationId}:${entry.speciesId}:${entry.minLevel}:${entry.maxLevel}`,
        ),
        revisionId,
        ids.form.get(entry.speciesId),
        entry.weight,
        entry.minLevel,
        entry.maxLevel,
        true,
        JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [], blockedUnlockKeys: [] }),
      ];
    }),
    "",
  );

  return { ...ids, encounterTable };
}

export async function importGen123(): Promise<{
  releaseId: string;
  status: string;
  counts: Readonly<Record<string, number>>;
}> {
  const source = Gen123Source.fromEnvironment();
  await source.assertComplete();
  const model = await loadGen123Model(source);
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rulesetId = await ensureRuleset(client, model);
    const release = await ensureRelease(client, rulesetId);
    if (release.status !== "DRAFT") {
      await client.query("COMMIT");
      return {
        releaseId: release.id,
        status: release.status,
        counts: {
          species: model.species.length,
          moves: model.moves.length,
          abilities: model.abilityRows.length,
          natures: model.natureRows.length,
          learnsets: model.learnsets.length,
          evolutions: model.evolutions.length,
          areas: model.locationRows.length,
          encounters: model.encounters.length,
        },
      };
    }
    const ids = await ensureIdentities(client, model);
    await importReleaseChildren(client, release.id, model, ids);
    await client.query("COMMIT");
    return {
      releaseId: release.id,
      status: "DRAFT",
      counts: {
        species: model.species.length,
        moves: model.moves.length,
        abilities: model.abilityRows.length,
        natures: model.natureRows.length,
        learnsets: model.learnsets.length,
        evolutions: model.evolutions.length,
        areas: model.locationRows.length,
        encounters: model.encounters.length,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("import.ts")) {
  const result = await importGen123();
  console.log(JSON.stringify({ source: GEN123_SOURCE, ...result }, null, 2));
}
