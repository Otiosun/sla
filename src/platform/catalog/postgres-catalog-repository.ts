import type { Pool, PoolClient } from "pg";
import {
  ContentLifecycleStatusSchema,
  type CatalogCoverage,
  type RulesetSnapshot,
  type ValidationReport,
} from "../../modules/catalog/contracts.js";
import type {
  CatalogReleaseRecord,
  CatalogRepository,
  CatalogTransaction,
  RulesetRecord,
} from "../../modules/catalog/service.js";
import type { CatalogSnapshotWithEffects } from "../../modules/catalog/validation.js";
import { withTransaction } from "../db/transaction.js";

function expectOneRow(rowCount: number | null, operation: string): void {
  if (rowCount !== 1) throw new Error(`${operation} did not affect exactly one row`);
}

interface RulesetRow {
  readonly id: string;
  readonly status: string;
  readonly config: unknown;
  readonly config_fingerprint: string | null;
}

interface ReleaseRow {
  readonly id: string;
  readonly release_no: string;
  readonly status: string;
  readonly parent_release_id: string | null;
  readonly default_ruleset_id: string;
  readonly content_fingerprint: string | null;
}

class PostgresCatalogTransaction implements CatalogTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async loadRuleset(rulesetId: string, lock = false): Promise<RulesetRecord | null> {
    const result = await this.client.query<RulesetRow>(
      `SELECT id, status, config, config_fingerprint
       FROM rulesets
       WHERE id = $1
       ${lock ? "FOR UPDATE" : ""}`,
      [rulesetId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const matchups = await this.client.query<{
      attacking_type_id: string;
      defending_type_id: string;
      multiplier_basis_points: number;
    }>(
      `SELECT attacking_type_id, defending_type_id, multiplier_basis_points
       FROM type_matchups
       WHERE ruleset_id = $1
       ORDER BY attacking_type_id, defending_type_id`,
      [rulesetId],
    );

    return {
      id: row.id,
      status: ContentLifecycleStatusSchema.parse(row.status),
      config: row.config,
      configFingerprint: row.config_fingerprint,
      typeMatchups: matchups.rows.map((entry) => ({
        attackingTypeId: entry.attacking_type_id,
        defendingTypeId: entry.defending_type_id,
        multiplierBasisPoints: entry.multiplier_basis_points,
      })),
    };
  }

  public async setRulesetValidated(
    rulesetId: string,
    report: ValidationReport,
    fingerprint: string,
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE rulesets
       SET status = 'VALIDATED',
           validated_at = now(),
           validation_report = $2::jsonb,
           config_fingerprint = $3
       WHERE id = $1 AND status = 'DRAFT'`,
      [rulesetId, JSON.stringify(report), fingerprint],
    );
    expectOneRow(result.rowCount, "ruleset validation transition");
  }

  public async setRulesetPublished(rulesetId: string): Promise<void> {
    const result = await this.client.query(
      `UPDATE rulesets
       SET status = 'PUBLISHED', published_at = now()
       WHERE id = $1 AND status = 'VALIDATED'`,
      [rulesetId],
    );
    expectOneRow(result.rowCount, "ruleset publish transition");
  }

  public async loadReleaseRecord(releaseId: string, lock = false): Promise<CatalogReleaseRecord | null> {
    const result = await this.client.query<ReleaseRow>(
      `SELECT id, release_no::text, status, parent_release_id, default_ruleset_id, content_fingerprint
       FROM content_releases
       WHERE id = $1
       ${lock ? "FOR UPDATE" : ""}`,
      [releaseId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      status: ContentLifecycleStatusSchema.parse(row.status),
      contentFingerprint: row.content_fingerprint,
      parentReleaseId: row.parent_release_id,
    };
  }

  private async loadCoverage(releaseId: string): Promise<CatalogCoverage> {
    const [types, species, forms, moves, abilities, items, natures, regions, areas, connections, tables] =
      await Promise.all([
        this.ids("pokemon_type_revisions", "type_id", releaseId),
        this.ids("pokemon_species_revisions", "species_id", releaseId),
        this.ids("pokemon_form_revisions", "form_id", releaseId),
        this.ids("move_revisions", "move_id", releaseId),
        this.ids("ability_revisions", "ability_id", releaseId),
        this.ids("item_revisions", "item_id", releaseId),
        this.ids("nature_revisions", "nature_id", releaseId),
        this.ids("region_revisions", "region_id", releaseId),
        this.ids("area_revisions", "area_id", releaseId),
        this.ids("area_connection_revisions", "connection_id", releaseId),
        this.ids("encounter_table_revisions", "encounter_table_id", releaseId),
      ]);
    return {
      types,
      species,
      forms,
      moves,
      abilities,
      items,
      natures,
      regions,
      areas,
      connections,
      encounterTables: tables,
    };
  }

  private async ids(table: string, column: string, releaseId: string): Promise<readonly string[]> {
    const allowed = new Set([
      "pokemon_type_revisions:type_id",
      "pokemon_species_revisions:species_id",
      "pokemon_form_revisions:form_id",
      "move_revisions:move_id",
      "ability_revisions:ability_id",
      "item_revisions:item_id",
      "nature_revisions:nature_id",
      "region_revisions:region_id",
      "area_revisions:area_id",
      "area_connection_revisions:connection_id",
      "encounter_table_revisions:encounter_table_id",
    ]);
    if (!allowed.has(`${table}:${column}`)) throw new Error("Invalid catalog coverage query");
    const result = await this.client.query<{ id: string }>(
      `SELECT ${column} AS id FROM ${table} WHERE content_release_id = $1 ORDER BY ${column}`,
      [releaseId],
    );
    return result.rows.map((row) => row.id);
  }

  public async loadCatalogSnapshot(releaseId: string): Promise<CatalogSnapshotWithEffects | null> {
    const releaseResult = await this.client.query<ReleaseRow>(
      `SELECT id, release_no::text, status, parent_release_id, default_ruleset_id, content_fingerprint
       FROM content_releases WHERE id = $1`,
      [releaseId],
    );
    const release = releaseResult.rows[0];
    if (release === undefined) return null;

    const ruleset = await this.loadRuleset(release.default_ruleset_id);
    if (ruleset === null) throw new Error("Release default ruleset disappeared despite foreign key");

    const [
      types,
      species,
      forms,
      moves,
      abilities,
      items,
      natures,
      effects,
      regions,
      areas,
      connections,
      formAbilities,
      learnsets,
      evolutions,
      encounterTables,
    ] = await Promise.all([
      this.client.query<{ type_id: string; display_name: string; active: boolean }>(
        `SELECT type_id, display_name, active FROM pokemon_type_revisions
         WHERE content_release_id = $1 ORDER BY type_id`,
        [releaseId],
      ),
      this.client.query<{ species_id: string; display_name: string; active: boolean }>(
        `SELECT species_id, display_name, active FROM pokemon_species_revisions
         WHERE content_release_id = $1 ORDER BY species_id`,
        [releaseId],
      ),
      this.client.query<{
        form_id: string;
        species_id: string;
        type1_id: string;
        type2_id: string | null;
        active: boolean;
      }>(
        `SELECT pfr.form_id, pf.species_id, pfr.type1_id, pfr.type2_id, pfr.active
         FROM pokemon_form_revisions pfr
         JOIN pokemon_forms pf ON pf.id = pfr.form_id
         WHERE pfr.content_release_id = $1
         ORDER BY pfr.form_id`,
        [releaseId],
      ),
      this.client.query<{
        move_id: string;
        type_id: string;
        category: "PHYSICAL" | "SPECIAL" | "STATUS";
        power: number | null;
        accuracy: number | null;
        priority: number;
        max_pp: number | null;
        effect_key: string | null;
        effect_config: unknown;
        active: boolean;
      }>(
        `SELECT move_id, type_id, category, power, accuracy, priority, max_pp,
                effect_key, effect_config, active
         FROM move_revisions WHERE content_release_id = $1 ORDER BY move_id`,
        [releaseId],
      ),
      this.client.query<{
        ability_id: string;
        effect_key: string | null;
        effect_config: unknown;
        active: boolean;
      }>(
        `SELECT ability_id, effect_key, effect_config, active
         FROM ability_revisions WHERE content_release_id = $1 ORDER BY ability_id`,
        [releaseId],
      ),
      this.client.query<{
        item_id: string;
        item_kind: string;
        effect_key: string | null;
        effect_config: unknown;
        active: boolean;
      }>(
        `SELECT item_id, item_kind, effect_key, effect_config, active
         FROM item_revisions WHERE content_release_id = $1 ORDER BY item_id`,
        [releaseId],
      ),
      this.client.query<{
        nature_id: string;
        increased_stat: string | null;
        decreased_stat: string | null;
        active: boolean;
      }>(
        `SELECT nature_id, increased_stat, decreased_stat, active
         FROM nature_revisions WHERE content_release_id = $1 ORDER BY nature_id`,
        [releaseId],
      ),
      this.client.query<{
        effect_id: string;
        scope: "PLAYER" | "POKEMON" | "BATTLE_PARTICIPANT" | "AREA";
        stacking_policy: string;
        duration_model: string;
        rules: unknown;
        active: boolean;
      }>(
        `SELECT effect_id, scope, stacking_policy, duration_model, rules, active
         FROM effect_revisions WHERE content_release_id = $1 ORDER BY effect_id`,
        [releaseId],
      ),
      this.client.query<{ region_id: string; active: boolean }>(
        `SELECT region_id, active FROM region_revisions
         WHERE content_release_id = $1 ORDER BY region_id`,
        [releaseId],
      ),
      this.client.query<{ area_id: string; region_id: string; active: boolean }>(
        `SELECT ar.area_id, a.region_id, ar.active
         FROM area_revisions ar JOIN areas a ON a.id = ar.area_id
         WHERE ar.content_release_id = $1 ORDER BY ar.area_id`,
        [releaseId],
      ),
      this.client.query<{
        connection_id: string;
        from_area_id: string;
        to_area_id: string;
        active: boolean;
      }>(
        `SELECT acr.connection_id, ac.from_area_id, ac.to_area_id, acr.active
         FROM area_connection_revisions acr
         JOIN area_connections ac ON ac.id = acr.connection_id
         WHERE acr.content_release_id = $1 ORDER BY acr.connection_id`,
        [releaseId],
      ),
      this.client.query<{ form_id: string; ability_id: string; active: boolean }>(
        `SELECT form_id, ability_id, active FROM pokemon_form_ability_options
         WHERE content_release_id = $1 ORDER BY form_id, ability_id`,
        [releaseId],
      ),
      this.client.query<{
        form_id: string;
        move_id: string;
        learn_method: string;
        learn_level: number | null;
        active: boolean;
      }>(
        `SELECT form_id, move_id, learn_method, learn_level, active
         FROM move_learnset_entries
         WHERE content_release_id = $1 ORDER BY form_id, move_id, learn_method, learn_level NULLS FIRST`,
        [releaseId],
      ),
      this.client.query<{
        from_form_id: string;
        to_form_id: string;
        trigger_kind: "LEVEL" | "ITEM" | "CONDITION";
        trigger_config: unknown;
        active: boolean;
      }>(
        `SELECT from_form_id, to_form_id, trigger_kind, trigger_config, active
         FROM evolution_rules
         WHERE content_release_id = $1 ORDER BY from_form_id, to_form_id, trigger_kind`,
        [releaseId],
      ),
      this.client.query<{
        revision_id: string;
        encounter_table_id: string;
        area_id: string;
        active: boolean;
      }>(
        `SELECT etr.id AS revision_id, etr.encounter_table_id, et.area_id, etr.active
         FROM encounter_table_revisions etr
         JOIN encounter_tables et ON et.id = etr.encounter_table_id
         WHERE etr.content_release_id = $1 ORDER BY etr.encounter_table_id`,
        [releaseId],
      ),
    ]);

    const tableRows = await Promise.all(
      encounterTables.rows.map(async (table) => {
        const entries = await this.client.query<{
          form_id: string;
          weight: string;
          min_level: number;
          max_level: number;
          active: boolean;
        }>(
          `SELECT form_id, weight::text, min_level, max_level, active
           FROM encounter_entries
           WHERE encounter_table_revision_id = $1
           ORDER BY id`,
          [table.revision_id],
        );
        return {
          encounterTableId: table.encounter_table_id,
          areaId: table.area_id,
          active: table.active,
          entries: entries.rows.map((entry) => ({
            formId: entry.form_id,
            weight: entry.weight,
            minLevel: entry.min_level,
            maxLevel: entry.max_level,
            active: entry.active,
          })),
        };
      }),
    );

    const parentCoverage =
      release.parent_release_id === null ? null : await this.loadCoverage(release.parent_release_id);

    return {
      release: {
        id: release.id,
        releaseNo: release.release_no,
        status: ContentLifecycleStatusSchema.parse(release.status),
        parentReleaseId: release.parent_release_id,
        defaultRulesetId: release.default_ruleset_id,
      },
      ruleset: ruleset as RulesetSnapshot,
      types: types.rows.map((entry) => ({
        typeId: entry.type_id,
        displayName: entry.display_name,
        active: entry.active,
      })),
      species: species.rows.map((entry) => ({
        speciesId: entry.species_id,
        displayName: entry.display_name,
        active: entry.active,
      })),
      forms: forms.rows.map((entry) => ({
        formId: entry.form_id,
        speciesId: entry.species_id,
        type1Id: entry.type1_id,
        type2Id: entry.type2_id,
        active: entry.active,
      })),
      moves: moves.rows.map((entry) => ({
        moveId: entry.move_id,
        typeId: entry.type_id,
        category: entry.category,
        power: entry.power,
        accuracy: entry.accuracy,
        priority: entry.priority,
        maxPp: entry.max_pp,
        effectKey: entry.effect_key,
        effectConfig: entry.effect_config,
        active: entry.active,
      })),
      abilities: abilities.rows.map((entry) => ({
        abilityId: entry.ability_id,
        effectKey: entry.effect_key,
        effectConfig: entry.effect_config,
        active: entry.active,
      })),
      items: items.rows.map((entry) => ({
        itemId: entry.item_id,
        itemKind: entry.item_kind,
        effectKey: entry.effect_key,
        effectConfig: entry.effect_config,
        active: entry.active,
      })),
      natures: natures.rows.map((entry) => ({
        natureId: entry.nature_id,
        increasedStat: entry.increased_stat,
        decreasedStat: entry.decreased_stat,
        active: entry.active,
      })),
      effects: effects.rows.map((entry) => ({
        effectId: entry.effect_id,
        scope: entry.scope,
        stackingPolicy: entry.stacking_policy,
        durationModel: entry.duration_model,
        rules: entry.rules,
        active: entry.active,
      })),
      regions: regions.rows.map((entry) => ({ regionId: entry.region_id, active: entry.active })),
      areas: areas.rows.map((entry) => ({
        areaId: entry.area_id,
        regionId: entry.region_id,
        active: entry.active,
      })),
      connections: connections.rows.map((entry) => ({
        connectionId: entry.connection_id,
        fromAreaId: entry.from_area_id,
        toAreaId: entry.to_area_id,
        active: entry.active,
      })),
      formAbilities: formAbilities.rows.map((entry) => ({
        formId: entry.form_id,
        abilityId: entry.ability_id,
        active: entry.active,
      })),
      learnsets: learnsets.rows.map((entry) => ({
        formId: entry.form_id,
        moveId: entry.move_id,
        learnMethod: entry.learn_method,
        learnLevel: entry.learn_level,
        active: entry.active,
      })),
      evolutions: evolutions.rows.map((entry) => ({
        fromFormId: entry.from_form_id,
        toFormId: entry.to_form_id,
        triggerKind: entry.trigger_kind,
        triggerConfig: entry.trigger_config,
        active: entry.active,
      })),
      encounterTables: tableRows,
      parentCoverage,
    };
  }

  public async setReleaseValidated(
    releaseId: string,
    report: ValidationReport,
    fingerprint: string,
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE content_releases
       SET status = 'VALIDATED', validated_at = now(), validation_report = $2::jsonb,
           content_fingerprint = $3
       WHERE id = $1 AND status = 'DRAFT'`,
      [releaseId, JSON.stringify(report), fingerprint],
    );
    expectOneRow(result.rowCount, "content release validation transition");
  }

  public async setReleasePublished(releaseId: string): Promise<void> {
    const result = await this.client.query(
      `UPDATE content_releases
       SET status = 'PUBLISHED', published_at = now()
       WHERE id = $1 AND status = 'VALIDATED'`,
      [releaseId],
    );
    expectOneRow(result.rowCount, "content release publish transition");
  }

  public async setReleaseArchived(releaseId: string): Promise<void> {
    const result = await this.client.query(
      `UPDATE content_releases SET status = 'ARCHIVED'
       WHERE id = $1 AND status = 'PUBLISHED'`,
      [releaseId],
    );
    expectOneRow(result.rowCount, "content release archive transition");
  }

  public async activateRelease(releaseId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO content_release_pointers(pointer_key, content_release_id)
       VALUES ('ACTIVE', $1)
       ON CONFLICT (pointer_key)
       DO UPDATE SET content_release_id = EXCLUDED.content_release_id,
                     revision = content_release_pointers.revision + 1,
                     updated_at = now()`,
      [releaseId],
    );
  }

  public async activeReleaseId(): Promise<string | null> {
    const result = await this.client.query<{ content_release_id: string }>(
      `SELECT content_release_id FROM content_release_pointers WHERE pointer_key = 'ACTIVE' FOR UPDATE`,
    );
    return result.rows[0]?.content_release_id ?? null;
  }

  public async cloneRelease(input: {
    readonly parentReleaseId: string;
    readonly newReleaseId: string;
    readonly releaseNo: bigint;
    readonly name: string;
  }): Promise<void> {
    const inserted = await this.client.query(
      `INSERT INTO content_releases(
         id, release_no, name, status, parent_release_id, default_ruleset_id
       )
       SELECT $2, $3, $4, 'DRAFT', id, default_ruleset_id
       FROM content_releases
       WHERE id = $1 AND status IN ('PUBLISHED', 'ARCHIVED')`,
      [input.parentReleaseId, input.newReleaseId, input.releaseNo.toString(), input.name],
    );
    expectOneRow(inserted.rowCount, "content release clone root");

    const copyStatements = [
      `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name, active, data)
       SELECT gen_random_uuid(), $2, type_id, display_name, active, data
       FROM pokemon_type_revisions WHERE content_release_id = $1`,
      `INSERT INTO pokemon_species_revisions(id, content_release_id, species_id, display_name, catch_rate, base_exp, active, data)
       SELECT gen_random_uuid(), $2, species_id, display_name, catch_rate, base_exp, active, data
       FROM pokemon_species_revisions WHERE content_release_id = $1`,
      `INSERT INTO pokemon_form_revisions(id, content_release_id, form_id, display_name, type1_id, type2_id,
                                          base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense,
                                          base_speed, active, data)
       SELECT gen_random_uuid(), $2, form_id, display_name, type1_id, type2_id,
              base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense,
              base_speed, active, data
       FROM pokemon_form_revisions WHERE content_release_id = $1`,
      `INSERT INTO move_revisions(id, content_release_id, move_id, display_name, type_id, category, power,
                                  accuracy, priority, max_pp, effect_key, effect_config, active)
       SELECT gen_random_uuid(), $2, move_id, display_name, type_id, category, power,
              accuracy, priority, max_pp, effect_key, effect_config, active
       FROM move_revisions WHERE content_release_id = $1`,
      `INSERT INTO ability_revisions(id, content_release_id, ability_id, display_name, effect_key, effect_config, active)
       SELECT gen_random_uuid(), $2, ability_id, display_name, effect_key, effect_config, active
       FROM ability_revisions WHERE content_release_id = $1`,
      `INSERT INTO item_revisions(id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config, active)
       SELECT gen_random_uuid(), $2, item_id, display_name, item_kind, effect_key, effect_config, active
       FROM item_revisions WHERE content_release_id = $1`,
      `INSERT INTO nature_revisions(id, content_release_id, nature_id, display_name, increased_stat, decreased_stat, active)
       SELECT gen_random_uuid(), $2, nature_id, display_name, increased_stat, decreased_stat, active
       FROM nature_revisions WHERE content_release_id = $1`,
      `INSERT INTO effect_revisions(id, content_release_id, effect_id, scope, stacking_policy, duration_model, rules, active)
       SELECT gen_random_uuid(), $2, effect_id, scope, stacking_policy, duration_model, rules, active
       FROM effect_revisions WHERE content_release_id = $1`,
      `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active, data)
       SELECT gen_random_uuid(), $2, region_id, display_name, active, data
       FROM region_revisions WHERE content_release_id = $1`,
      `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data)
       SELECT gen_random_uuid(), $2, area_id, display_name, active, data
       FROM area_revisions WHERE content_release_id = $1`,
      `INSERT INTO area_connection_revisions(id, content_release_id, connection_id, access_rule, active)
       SELECT gen_random_uuid(), $2, connection_id, access_rule, active
       FROM area_connection_revisions WHERE content_release_id = $1`,
      `INSERT INTO encounter_table_revisions(id, content_release_id, encounter_table_id, active, conditions)
       SELECT gen_random_uuid(), $2, encounter_table_id, active, conditions
       FROM encounter_table_revisions WHERE content_release_id = $1`,
      `INSERT INTO pokemon_form_ability_options(id, content_release_id, form_id, ability_id, slot_kind, active)
       SELECT gen_random_uuid(), $2, form_id, ability_id, slot_kind, active
       FROM pokemon_form_ability_options WHERE content_release_id = $1`,
      `INSERT INTO move_learnset_entries(id, content_release_id, form_id, move_id, learn_method, learn_level, source_key, active)
       SELECT gen_random_uuid(), $2, form_id, move_id, learn_method, learn_level, source_key, active
       FROM move_learnset_entries WHERE content_release_id = $1`,
      `INSERT INTO evolution_rules(id, content_release_id, from_form_id, to_form_id, trigger_kind, trigger_config, active)
       SELECT gen_random_uuid(), $2, from_form_id, to_form_id, trigger_kind, trigger_config, active
       FROM evolution_rules WHERE content_release_id = $1`,
    ];
    for (const statement of copyStatements) {
      await this.client.query(statement, [input.parentReleaseId, input.newReleaseId]);
    }

    await this.client.query(
      `INSERT INTO encounter_entries(
         id, encounter_table_revision_id, form_id, weight, min_level, max_level, active, conditions
       )
       SELECT gen_random_uuid(), new_revision.id, entry.form_id, entry.weight, entry.min_level,
              entry.max_level, entry.active, entry.conditions
       FROM encounter_entries entry
       JOIN encounter_table_revisions old_revision
         ON old_revision.id = entry.encounter_table_revision_id
       JOIN encounter_table_revisions new_revision
         ON new_revision.content_release_id = $2
        AND new_revision.encounter_table_id = old_revision.encounter_table_id
       WHERE old_revision.content_release_id = $1`,
      [input.parentReleaseId, input.newReleaseId],
    );
  }
}

export class PostgresCatalogRepository implements CatalogRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (transaction: CatalogTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresCatalogTransaction(client)),
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  public async read<T>(work: (transaction: CatalogTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresCatalogTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
