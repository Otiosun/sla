import { z } from "zod";
import {
  EvolutionTriggerSchemas,
  RulesetConfigSchema,
  validateEffectConfig,
  type CatalogCoverage,
  type CatalogSnapshot,
  type RulesetSnapshot,
  type ValidationIssue,
  type ValidationReport,
} from "./contracts.js";

export const EffectProgramSchema = z
  .object({
    version: z.literal(1),
    steps: z
      .array(
        z
          .object({
            effectKey: z.string().min(1).max(64),
            config: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

export interface CatalogSnapshotWithEffects extends CatalogSnapshot {
  readonly effects: readonly {
    readonly effectId: string;
    readonly scope: "PLAYER" | "POKEMON" | "BATTLE_PARTICIPANT" | "AREA";
    readonly stackingPolicy: string;
    readonly durationModel: string;
    readonly rules: unknown;
    readonly active: boolean;
  }[];
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message };
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: issues.length === 0, issues };
}

function addZodIssues(
  target: ValidationIssue[],
  code: string,
  path: string,
  result: z.ZodSafeParseResult<unknown>,
): void {
  if (result.success) return;
  for (const zodIssue of result.error.issues) {
    const suffix = zodIssue.path.length === 0 ? "" : `.${zodIssue.path.join(".")}`;
    target.push(issue(code, `${path}${suffix}`, zodIssue.message));
  }
}

export function validateRulesetSnapshot(snapshot: RulesetSnapshot): ValidationReport {
  const issues: ValidationIssue[] = [];
  addZodIssues(
    issues,
    "RULESET_CONFIG_INVALID",
    "ruleset.config",
    RulesetConfigSchema.safeParse(snapshot.config),
  );

  for (const [index, matchup] of snapshot.typeMatchups.entries()) {
    if (!Number.isSafeInteger(matchup.multiplierBasisPoints) || matchup.multiplierBasisPoints < 0) {
      issues.push(
        issue(
          "TYPE_MATCHUP_INVALID",
          `ruleset.typeMatchups.${index}.multiplierBasisPoints`,
          "Type matchup multiplier must be a non-negative safe integer",
        ),
      );
    }
  }

  return report(issues);
}

function validateEffectReference(
  issues: ValidationIssue[],
  path: string,
  effectKey: string | null,
  config: unknown,
): void {
  addZodIssues(issues, "EFFECT_CONFIG_INVALID", path, validateEffectConfig(effectKey, config));
}

function idSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

function requireParentCoverage(
  issues: ValidationIssue[],
  category: keyof CatalogCoverage,
  parentIds: readonly string[],
  currentIds: readonly string[],
): void {
  const current = idSet(currentIds);
  for (const id of parentIds) {
    if (!current.has(id)) {
      issues.push(
        issue(
          "RELEASE_SNAPSHOT_INCOMPLETE",
          `release.${category}`,
          `Revision for parent identity ${id} is missing from the child release snapshot`,
        ),
      );
    }
  }
}

export function validateCatalogSnapshot(snapshot: CatalogSnapshotWithEffects): ValidationReport {
  const issues: ValidationIssue[] = [];
  const rulesetReport = validateRulesetSnapshot(snapshot.ruleset);
  issues.push(...rulesetReport.issues);

  if (snapshot.release.defaultRulesetId !== snapshot.ruleset.id) {
    issues.push(
      issue(
        "RELEASE_RULESET_MISMATCH",
        "release.defaultRulesetId",
        "Loaded ruleset does not match release.defaultRulesetId",
      ),
    );
  }
  if (
    !(["VALIDATED", "PUBLISHED"] as const).includes(
      snapshot.ruleset.status as "VALIDATED" | "PUBLISHED",
    )
  ) {
    issues.push(
      issue(
        "RULESET_NOT_READY",
        "ruleset.status",
        "A release may validate only against a VALIDATED or PUBLISHED ruleset",
      ),
    );
  }

  const allTypeIds = idSet(snapshot.types.map((entry) => entry.typeId));
  const activeTypeIds = idSet(
    snapshot.types.filter((entry) => entry.active).map((entry) => entry.typeId),
  );
  const allSpeciesIds = idSet(snapshot.species.map((entry) => entry.speciesId));
  const activeSpeciesIds = idSet(
    snapshot.species.filter((entry) => entry.active).map((entry) => entry.speciesId),
  );
  const allFormIds = idSet(snapshot.forms.map((entry) => entry.formId));
  const activeFormIds = idSet(
    snapshot.forms.filter((entry) => entry.active).map((entry) => entry.formId),
  );
  const allMoveIds = idSet(snapshot.moves.map((entry) => entry.moveId));
  const activeMoveIds = idSet(
    snapshot.moves.filter((entry) => entry.active).map((entry) => entry.moveId),
  );
  const allAbilityIds = idSet(snapshot.abilities.map((entry) => entry.abilityId));
  const activeAbilityIds = idSet(
    snapshot.abilities.filter((entry) => entry.active).map((entry) => entry.abilityId),
  );
  const allItemIds = idSet(snapshot.items.map((entry) => entry.itemId));
  const activeItemIds = idSet(
    snapshot.items.filter((entry) => entry.active).map((entry) => entry.itemId),
  );
  const allNatureIds = idSet(snapshot.natures.map((entry) => entry.natureId));
  const activeRegionIds = idSet(
    snapshot.regions.filter((entry) => entry.active).map((entry) => entry.regionId),
  );
  const allRegionIds = idSet(snapshot.regions.map((entry) => entry.regionId));
  const activeAreaIds = idSet(
    snapshot.areas.filter((entry) => entry.active).map((entry) => entry.areaId),
  );
  const allAreaIds = idSet(snapshot.areas.map((entry) => entry.areaId));

  const minimumCategories: readonly [string, number][] = [
    ["types", activeTypeIds.size],
    ["species", activeSpeciesIds.size],
    ["forms", activeFormIds.size],
    ["moves", activeMoveIds.size],
    ["abilities", activeAbilityIds.size],
    ["items", activeItemIds.size],
    ["natures", snapshot.natures.filter((entry) => entry.active).length],
    ["regions", activeRegionIds.size],
    ["areas", activeAreaIds.size],
  ];
  for (const [category, count] of minimumCategories) {
    if (count === 0) {
      issues.push(
        issue("RELEASE_CATEGORY_EMPTY", `release.${category}`, `Release has no active ${category}`),
      );
    }
  }

  const matchupKeys = new Set(
    snapshot.ruleset.typeMatchups.map(
      (entry) => `${entry.attackingTypeId}:${entry.defendingTypeId}`,
    ),
  );
  for (const attackingTypeId of activeTypeIds) {
    for (const defendingTypeId of activeTypeIds) {
      if (!matchupKeys.has(`${attackingTypeId}:${defendingTypeId}`)) {
        issues.push(
          issue(
            "TYPE_CHART_INCOMPLETE",
            "ruleset.typeMatchups",
            `Missing matchup ${attackingTypeId} -> ${defendingTypeId}`,
          ),
        );
      }
    }
  }

  for (const [index, form] of snapshot.forms.entries()) {
    if (!allSpeciesIds.has(form.speciesId)) {
      issues.push(
        issue(
          "FORM_SPECIES_MISSING",
          `forms.${index}.speciesId`,
          "Form references a species absent from this release",
        ),
      );
    }
    if (!allTypeIds.has(form.type1Id) || (form.type2Id !== null && !allTypeIds.has(form.type2Id))) {
      issues.push(
        issue(
          "FORM_TYPE_MISSING",
          `forms.${index}`,
          "Form references a type absent from this release",
        ),
      );
    }
    if (form.active && !activeSpeciesIds.has(form.speciesId)) {
      issues.push(
        issue(
          "ACTIVE_FORM_HAS_INACTIVE_SPECIES",
          `forms.${index}.speciesId`,
          "Active form belongs to an inactive species",
        ),
      );
    }
    if (
      form.active &&
      (!activeTypeIds.has(form.type1Id) ||
        (form.type2Id !== null && !activeTypeIds.has(form.type2Id)))
    ) {
      issues.push(
        issue(
          "ACTIVE_FORM_HAS_INACTIVE_TYPE",
          `forms.${index}`,
          "Active form references an inactive type",
        ),
      );
    }
  }

  for (const [index, move] of snapshot.moves.entries()) {
    if (!allTypeIds.has(move.typeId)) {
      issues.push(
        issue(
          "MOVE_TYPE_MISSING",
          `moves.${index}.typeId`,
          "Move references a type absent from this release",
        ),
      );
    }
    if (move.active && !activeTypeIds.has(move.typeId)) {
      issues.push(
        issue(
          "ACTIVE_MOVE_HAS_INACTIVE_TYPE",
          `moves.${index}.typeId`,
          "Active move references an inactive type",
        ),
      );
    }
    validateEffectReference(
      issues,
      `moves.${index}.effectConfig`,
      move.effectKey,
      move.effectConfig,
    );
  }

  for (const [index, ability] of snapshot.abilities.entries()) {
    validateEffectReference(
      issues,
      `abilities.${index}.effectConfig`,
      ability.effectKey,
      ability.effectConfig,
    );
  }
  for (const [index, item] of snapshot.items.entries()) {
    validateEffectReference(
      issues,
      `items.${index}.effectConfig`,
      item.effectKey,
      item.effectConfig,
    );
  }

  for (const [index, effect] of snapshot.effects.entries()) {
    const parsed = EffectProgramSchema.safeParse(effect.rules);
    addZodIssues(issues, "EFFECT_PROGRAM_INVALID", `effects.${index}.rules`, parsed);
    if (parsed.success) {
      for (const [stepIndex, step] of parsed.data.steps.entries()) {
        validateEffectReference(
          issues,
          `effects.${index}.rules.steps.${stepIndex}.config`,
          step.effectKey,
          step.config,
        );
      }
    }
  }

  for (const [index, area] of snapshot.areas.entries()) {
    if (!allRegionIds.has(area.regionId)) {
      issues.push(
        issue(
          "AREA_REGION_MISSING",
          `areas.${index}.regionId`,
          "Area references a region absent from this release",
        ),
      );
    }
    if (area.active && !activeRegionIds.has(area.regionId)) {
      issues.push(
        issue(
          "ACTIVE_AREA_HAS_INACTIVE_REGION",
          `areas.${index}.regionId`,
          "Active area references an inactive region",
        ),
      );
    }
  }

  for (const [index, connection] of snapshot.connections.entries()) {
    if (!allAreaIds.has(connection.fromAreaId) || !allAreaIds.has(connection.toAreaId)) {
      issues.push(
        issue(
          "CONNECTION_AREA_MISSING",
          `connections.${index}`,
          "Connection references an area absent from this release",
        ),
      );
    }
    if (
      connection.active &&
      (!activeAreaIds.has(connection.fromAreaId) || !activeAreaIds.has(connection.toAreaId))
    ) {
      issues.push(
        issue(
          "ACTIVE_CONNECTION_HAS_INACTIVE_AREA",
          `connections.${index}`,
          "Active connection references an inactive area",
        ),
      );
    }
  }

  const activeAbilityByForm = new Map<string, number>();
  for (const [index, option] of snapshot.formAbilities.entries()) {
    if (!allFormIds.has(option.formId) || !allAbilityIds.has(option.abilityId)) {
      issues.push(
        issue(
          "FORM_ABILITY_REFERENCE_MISSING",
          `formAbilities.${index}`,
          "Form ability option references content absent from this release",
        ),
      );
    }
    if (option.active) {
      if (!activeFormIds.has(option.formId) || !activeAbilityIds.has(option.abilityId)) {
        issues.push(
          issue(
            "ACTIVE_FORM_ABILITY_INVALID",
            `formAbilities.${index}`,
            "Active form ability option references inactive content",
          ),
        );
      }
      activeAbilityByForm.set(option.formId, (activeAbilityByForm.get(option.formId) ?? 0) + 1);
    }
  }

  const activeMovesByForm = new Map<string, number>();
  for (const [index, learnset] of snapshot.learnsets.entries()) {
    if (!allFormIds.has(learnset.formId) || !allMoveIds.has(learnset.moveId)) {
      issues.push(
        issue(
          "LEARNSET_REFERENCE_MISSING",
          `learnsets.${index}`,
          "Learnset references a form or move absent from this release",
        ),
      );
    }
    if (learnset.learnMethod === "LEVEL" && learnset.learnLevel === null) {
      issues.push(
        issue(
          "LEARNSET_LEVEL_MISSING",
          `learnsets.${index}.learnLevel`,
          "LEVEL learnset entry requires learnLevel",
        ),
      );
    }
    if (learnset.active) {
      if (!activeFormIds.has(learnset.formId) || !activeMoveIds.has(learnset.moveId)) {
        issues.push(
          issue(
            "ACTIVE_LEARNSET_REFERENCE_INACTIVE",
            `learnsets.${index}`,
            "Active learnset references inactive content",
          ),
        );
      }
      activeMovesByForm.set(learnset.formId, (activeMovesByForm.get(learnset.formId) ?? 0) + 1);
    }
  }

  for (const formId of activeFormIds) {
    if ((activeAbilityByForm.get(formId) ?? 0) === 0) {
      issues.push(
        issue(
          "FORM_WITHOUT_ABILITY",
          "formAbilities",
          `Active form ${formId} has no active ability option`,
        ),
      );
    }
    if ((activeMovesByForm.get(formId) ?? 0) === 0) {
      issues.push(
        issue(
          "FORM_WITHOUT_MOVE",
          "learnsets",
          `Active form ${formId} has no active learnset entry`,
        ),
      );
    }
  }

  for (const [index, evolution] of snapshot.evolutions.entries()) {
    if (!allFormIds.has(evolution.fromFormId) || !allFormIds.has(evolution.toFormId)) {
      issues.push(
        issue(
          "EVOLUTION_FORM_MISSING",
          `evolutions.${index}`,
          "Evolution references a form absent from this release",
        ),
      );
    }
    const schema = EvolutionTriggerSchemas[evolution.triggerKind];
    const parsed = schema.safeParse(evolution.triggerConfig);
    addZodIssues(issues, "EVOLUTION_TRIGGER_INVALID", `evolutions.${index}.triggerConfig`, parsed);
    if (parsed.success && evolution.triggerKind === "ITEM") {
      const itemId = (parsed.data as { itemId: string }).itemId;
      if (!activeItemIds.has(itemId)) {
        issues.push(
          issue(
            "EVOLUTION_ITEM_MISSING",
            `evolutions.${index}.triggerConfig.itemId`,
            "Evolution item is absent or inactive in this release",
          ),
        );
      }
    }
  }

  for (const [tableIndex, table] of snapshot.encounterTables.entries()) {
    if (!allAreaIds.has(table.areaId)) {
      issues.push(
        issue(
          "ENCOUNTER_AREA_MISSING",
          `encounterTables.${tableIndex}.areaId`,
          "Encounter table area is absent from this release",
        ),
      );
    }
    if (table.active && !activeAreaIds.has(table.areaId)) {
      issues.push(
        issue(
          "ACTIVE_ENCOUNTER_AREA_INACTIVE",
          `encounterTables.${tableIndex}.areaId`,
          "Active encounter table points to inactive area",
        ),
      );
    }
    const activeEntries = table.entries.filter((entry) => entry.active);
    if (table.active && activeEntries.length === 0) {
      issues.push(
        issue(
          "ENCOUNTER_TABLE_EMPTY",
          `encounterTables.${tableIndex}.entries`,
          "Active encounter table has no active entries",
        ),
      );
    }
    for (const [entryIndex, entry] of table.entries.entries()) {
      if (!allFormIds.has(entry.formId)) {
        issues.push(
          issue(
            "ENCOUNTER_FORM_MISSING",
            `encounterTables.${tableIndex}.entries.${entryIndex}.formId`,
            "Encounter entry form is absent from this release",
          ),
        );
      }
      if (entry.active && !activeFormIds.has(entry.formId)) {
        issues.push(
          issue(
            "ACTIVE_ENCOUNTER_FORM_INACTIVE",
            `encounterTables.${tableIndex}.entries.${entryIndex}.formId`,
            "Active encounter entry references inactive form",
          ),
        );
      }
      const weight = Number(entry.weight);
      if (
        !Number.isSafeInteger(weight) ||
        weight <= 0 ||
        entry.minLevel < 1 ||
        entry.maxLevel < entry.minLevel
      ) {
        issues.push(
          issue(
            "ENCOUNTER_RANGE_INVALID",
            `encounterTables.${tableIndex}.entries.${entryIndex}`,
            "Encounter entry has invalid weight or level range",
          ),
        );
      }
    }
  }

  if (snapshot.parentCoverage !== null) {
    requireParentCoverage(issues, "types", snapshot.parentCoverage.types, [...allTypeIds]);
    requireParentCoverage(issues, "species", snapshot.parentCoverage.species, [...allSpeciesIds]);
    requireParentCoverage(issues, "forms", snapshot.parentCoverage.forms, [...allFormIds]);
    requireParentCoverage(issues, "moves", snapshot.parentCoverage.moves, [...allMoveIds]);
    requireParentCoverage(issues, "abilities", snapshot.parentCoverage.abilities, [
      ...allAbilityIds,
    ]);
    requireParentCoverage(issues, "items", snapshot.parentCoverage.items, [...allItemIds]);
    requireParentCoverage(issues, "natures", snapshot.parentCoverage.natures, [...allNatureIds]);
    requireParentCoverage(issues, "regions", snapshot.parentCoverage.regions, [...allRegionIds]);
    requireParentCoverage(issues, "areas", snapshot.parentCoverage.areas, [...allAreaIds]);
    requireParentCoverage(
      issues,
      "connections",
      snapshot.parentCoverage.connections,
      snapshot.connections.map((entry) => entry.connectionId),
    );
    requireParentCoverage(
      issues,
      "encounterTables",
      snapshot.parentCoverage.encounterTables,
      snapshot.encounterTables.map((entry) => entry.encounterTableId),
    );
  }

  return report(issues);
}
