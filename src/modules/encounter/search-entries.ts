import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { encounterConditionsAllow } from "../catalog/encounter-contracts.js";
import type {
  CreateEncounterInput,
  EncounterPlayerContext,
  EncounterTableEntryRecord,
} from "./contracts.js";
import { encounterNotReady } from "./errors.js";
import type { EncounterTransaction } from "./ports.js";

const unavailable = () =>
  err(
    appError(
      "FLOW_BLOCKED",
      "Alvo indisponível para esta busca. Consulte sua RotomDex e a área atual.",
    ),
  );
/** Shares exactly the normal table/condition selection, without disclosing unknown content. */
export async function resolveSearchEntries(
  tx: Pick<EncounterTransaction, "tables" | "wildBuild" | "knownSpecies">,
  releaseId: string,
  context: EncounterPlayerContext,
  input: CreateEncounterInput,
): Promise<Result<readonly EncounterTableEntryRecord[]>> {
  if (context.areaId === null) return unavailable();
  const unlocks = new Set(context.unlockKeys);
  const tables = (await tx.tables(releaseId, context.areaId)).filter(
    (table) =>
      table.active &&
      encounterConditionsAllow(table.conditions, unlocks, input.environment ?? {}) &&
      (input.encounterTableSlug === undefined || table.slug === input.encounterTableSlug),
  );
  if (tables.length === 0)
    return err(encounterNotReady("No eligible encounter table exists for the current area"));
  if (tables.length > 1)
    return err(
      encounterNotReady(
        "Multiple encounter tables are eligible; an explicit encounterTableSlug is required",
      ),
    );
  const table = tables[0];
  if (!table) return err(encounterNotReady("Encounter table could not be resolved"));
  const entries = table.entries.filter(
    (entry) =>
      entry.active && encounterConditionsAllow(entry.conditions, unlocks, input.environment ?? {}),
  );
  if (entries.length === 0)
    return err(encounterNotReady("Encounter table has no eligible active entries"));
  if (input.searchTarget === undefined) return ok(entries);
  const slug = input.searchTarget.speciesSlug;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug)) return unavailable();
  const speciesId = await tx.knownSpecies?.(input.playerId, slug);
  if (!speciesId) return unavailable();
  const targets = new Set<string>();
  for (const entry of entries) {
    const build = await tx.wildBuild(releaseId, entry.formId);
    if (build?.speciesId === speciesId) targets.add(entry.entryId);
  }
  if (targets.size === 0) return unavailable();
  const weighted = entries.flatMap((entry) => {
    const target = targets.has(entry.entryId);
    if (input.searchTarget?.followTrail) return target ? [entry] : [];
    return [{ ...entry, weight: target ? entry.weight * 3 : entry.weight }];
  });
  let total = 0;
  for (const entry of weighted) {
    total += entry.weight;
    if (!Number.isSafeInteger(entry.weight) || entry.weight <= 0 || !Number.isSafeInteger(total))
      return unavailable();
  }
  return ok(weighted);
}
