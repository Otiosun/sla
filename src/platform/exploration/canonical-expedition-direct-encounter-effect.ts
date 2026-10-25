import { createHash } from "node:crypto";
import { CounterRandomSource } from "../rng/counter-rng.js";
import type { EncounterSeedProvider } from "../../modules/encounter/ports.js";
import type { EncounterEnvironmentContext } from "../../modules/catalog/encounter-contracts.js";
import { EncounterService } from "../../modules/encounter/service.js";
import { chooseEncounterLevel } from "../../modules/encounter/generation.js";
import { drawExpeditionEncounterEntry } from "../../modules/exploration/expedition-encounter-weighting.js";
import {
  EXPEDITION_HUNT_SEARCH_MINUTES,
  prepareExpeditionHunt,
} from "../../modules/exploration/expedition-hunt-preflight.js";
import type { Clock } from "../clock/index.js";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import { appError, err, ok } from "../../shared-kernel/result.js";
import { encounterRepositoryForClient } from "../encounter/postgres-encounter-repository.js";
import type { FirstActionEffect } from "./postgres-expedition-first-action.js";
import { eligibleExpeditionPoolInTransaction } from "./postgres-eligible-expedition-pool.js";

export interface CanonicalExpeditionDirectEncounterInput {
  readonly encounterTableSlug: string;
  readonly environment: EncounterEnvironmentContext & {
    readonly timeOfDay: "DAY" | "NIGHT";
    readonly surface: "LAND" | "WATER";
  };
  /** A server-resolved identity only; never raw user text. */
  readonly targetSpeciesId: string | null;
  readonly seedProvider: EncounterSeedProvider;
  readonly clock: Clock;
  readonly encounterFeature: FeatureAvailability;
}

function invalidWorld() {
  return err(
    appError("FLOW_BLOCKED", "Expedition encounter is not eligible under the current World", {
      userMessage: "O cenário da busca mudou. Consulte a RotomDex e tente novamente.",
    }),
  );
}

/**
 * Atomic DIRECT_ENCOUNTER outcome only. The odds of NO_SIGNAL, TRAIL,
 * INCIDENTAL and DIRECT_ENCOUNTER have NOT been approved. This effect is
 * deliberately not bound to WhatsApp or offered for every /explorar search.
 *
 * Must be invoked ONLY as a FirstActionEffect by the V1.1 executor, after
 * the server has legitimately resolved DIRECT_ENCOUNTER. All catalog,
 * species, World, quota and time checks are repeated on its PoolClient.
 */
export function canonicalExpeditionDirectEncounterEffect(
  input: CanonicalExpeditionDirectEncounterInput,
): FirstActionEffect {
  const actionFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "EXPEDITION_DIRECT_ENCOUNTER_V1",
        input.encounterTableSlug,
        input.environment.timeOfDay,
        input.environment.surface,
        input.environment.rarity ?? null,
        input.environment.weatherKey ?? null,
        input.targetSpeciesId,
      ]),
    )
    .digest("hex");

  return {
    actionKey: "expedition.direct-encounter",
    actionFingerprint,
    async apply(client, context) {
      if (context.minutes !== EXPEDITION_HUNT_SEARCH_MINUTES) {
        return err(
          appError("ACTION_INVALID", "Direct encounter requires exactly 30 expedition minutes"),
        );
      }
      const state = await client.query<{
        period: "DAY" | "NIGHT";
        phase: "PREPARING" | "ACTIVE" | "ENDED";
        elapsed_minutes: number;
        consumed_week_key: string | null;
        end_reason: "CANCELLED" | "VOLUNTARY" | "CLOCK" | "BLACKOUT" | null;
      }>(
        `SELECT period,phase,elapsed_minutes,consumed_week_key::text,end_reason
           FROM solo_expeditions
          WHERE id=$1::uuid AND player_id=$2::uuid`,
        [context.expeditionId, context.playerId],
      );
      const expedition = state.rows[0];
      if (expedition === undefined || expedition.period !== input.environment.timeOfDay) {
        return invalidWorld();
      }

      const read = await eligibleExpeditionPoolInTransaction(client, {
        playerId: context.playerId,
        contentReleaseId: context.contentReleaseId,
        areaId: context.areaId,
        encounterTableSlug: input.encounterTableSlug,
        environment: input.environment,
      });
      if (read === null) return invalidWorld();

      const ready = prepareExpeditionHunt({
        expedition: {
          expeditionId: context.expeditionId,
          playerId: context.playerId,
          currentAreaId: context.areaId,
          period: expedition.period,
          phase: expedition.phase,
          elapsedMinutes: expedition.elapsed_minutes,
          consumedWeekKey: expedition.consumed_week_key,
          endReason: expedition.end_reason,
        },
        admission: {
          playerId: context.playerId,
          contentReleaseId: context.contentReleaseId,
          currentAreaId: context.areaId,
        },
        pool: read.pool,
        knownSpeciesIds: read.knownSpeciesIds,
        targetSpeciesId: input.targetSpeciesId,
        environment: input.environment,
        // The first-action executor checks this while holding player/World locks.
        hasActiveEncounterOrBattle: false,
      });
      if (!ready.ok) return ready;

      // The hunt RNG belongs to this transaction and is never passed through
      // a player-controlled roll. A failed effect/transaction commits neither
      // this draw nor an encounter.
      const rngSeed = input.seedProvider.create(`expedition:hunt:${context.idempotencyKey}`);
      const rng = new CounterRandomSource(rngSeed.seed);
      const selected = drawExpeditionEncounterEntry({
        pool: ready.value.pool,
        nextInt: (max) => rng.randomInt(max),
      });
      if (!selected.ok) return selected;
      const matching = read.pool.entries.find((row) => row.entryId === selected.value.entryId);
      if (
        matching === undefined ||
        matching.formId !== selected.value.formId ||
        matching.speciesId !== selected.value.speciesId
      ) {
        return invalidWorld();
      }
      const level = chooseEncounterLevel(matching, rng);

      // Reuse canonical EncounterService and *the same SQL client*. The form
      // override here is safe ONLY because this server-side effect drew it
      // from the freshly filtered published table. Force one solo participant.
      const encounterService = new EncounterService(
        encounterRepositoryForClient(client),
        input.seedProvider,
        input.clock,
        input.encounterFeature,
      );
      const spawned = await encounterService.createOrReplay({
        playerId: context.playerId,
        participantPlayerIds: [context.playerId],
        idempotencyKey: context.idempotencyKey,
        forcedFormId: selected.value.formId,
        forcedLevel: level,
        environment: input.environment,
      });
      if (!spawned.ok) return spawned;
      const wild = spawned.value.snapshot;
      if (
        spawned.value.playerId !== context.playerId ||
        spawned.value.areaId !== context.areaId ||
        spawned.value.contentReleaseId !== context.contentReleaseId ||
        wild.formId !== matching.formId ||
        wild.speciesId !== matching.speciesId ||
        wild.level !== level
      ) {
        return invalidWorld();
      }

      // JSON-safe, non-spoiler receipt. Do not mark the Encounter PRESENTED
      // until the real WhatsApp presentation path uses its state machine.
      return ok({
        kind: "EXPEDITION_DIRECT_ENCOUNTER" as const,
        encounterId: spawned.value.encounterId,
        contentReleaseId: context.contentReleaseId,
        areaId: context.areaId,
        entryId: matching.entryId,
        formId: matching.formId,
        level,
        encounterStatus: spawned.value.status,
      });
    },
  };
}
