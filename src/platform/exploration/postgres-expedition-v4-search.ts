import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  createSearchOutcomeEffect,
  readStoredSearchOutcome,
  type EncounterOutcomeEffect,
  type SearchOutcomePolicy,
  type StoredSearchOutcome,
} from "./expedition-search-outcome-effect.js";
import {
  readVerifiedExpeditionSearchEncounterPreview,
  type VerifiedExpeditionSearchEncounterPreview,
} from "./postgres-expedition-search-encounter-preview.js";
import {
  PostgresExpeditionRepository,
  type StoredSearchActionTransition,
} from "./postgres-expedition-repository.js";

export interface ExpeditionV4StagingSearchInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
}

export interface ExpeditionV4StagingSearchResult {
  readonly transition: StoredSearchActionTransition;
  readonly outcome: StoredSearchOutcome;
  readonly encounterPreview: VerifiedExpeditionSearchEncounterPreview | null;
}

/**
 * An opt-in PostgreSQL staging action. The caller supplies the real
 * PUBLISHED per-area/per-period policy and a trusted EncounterService adapter;
 * neither outcomes nor percentages can be provided by WhatsApp.
 *
 * The search outcome and any canonical Encounter must be persisted in the SAME
 * transaction that locks the player, charges exactly 30 minutes and reserves
 * the first weekly slot. Rejecting a missing/mismatched effect inside that
 * transaction is critical: a post-commit check alone cannot undo charges.
 */
export class PostgresExpeditionV4StagingSearch {
  public constructor(
    private readonly pool: Pool,
    private readonly expedition: Pick<PostgresExpeditionRepository, "executeSearchFree">,
    private readonly policy: SearchOutcomePolicy,
    private readonly encounter: EncounterOutcomeEffect,
  ) {}

  public async execute(
    input: ExpeditionV4StagingSearchInput,
  ): Promise<Result<ExpeditionV4StagingSearchResult>> {
    const effect = createSearchOutcomeEffect({
      policy: this.policy,
      encounter: this.encounter,
    });
    const action = await this.expedition.executeSearchFree({
      ...input,
      effect: async (client, persisted) => {
        const outcome = await effect(client, persisted);
        if (!outcome.ok) return outcome;
        const found = await readStoredSearchOutcome(
          client,
          persisted.playerId,
          outcome.value.effectRef,
        );
        if (
          found === null ||
          found.playerId !== persisted.playerId ||
          found.expeditionId !== persisted.expeditionId ||
          found.expeditionRevision !== persisted.revision ||
          (found.kind === "DIRECT" || found.kind === "INCIDENTAL") !== (found.encounterId !== null)
        ) {
          return err(appError("FLOW_BLOCKED", "Search outcome was not durably committed"));
        }
        if (found.encounterId !== null) {
          // Verify the real PUBLISHED species snapshot while charge, outcome
          // and encounter are still in the same rollback-capable transaction.
          const preview = await readVerifiedExpeditionSearchEncounterPreview(client, {
            playerId: persisted.playerId,
            areaId: persisted.areaId,
            outcomeId: found.outcomeId,
            encounterId: found.encounterId,
          });
          if (!preview.ok) return preview;
        }
        return outcome;
      },
    });
    if (!action.ok) return action;

    const client = await this.pool.connect();
    try {
      const found = await readStoredSearchOutcome(client, input.playerId, action.value.effectRef);
      if (
        found === null ||
        found.playerId !== input.playerId ||
        found.expeditionId !== input.expeditionId ||
        found.expeditionRevision !== input.expectedRevision ||
        (found.kind === "DIRECT" || found.kind === "INCIDENTAL") !== (found.encounterId !== null)
      ) {
        return err(appError("FLOW_BLOCKED", "Search receipt does not match the published outcome"));
      }
      if (found.encounterId === null) {
        return ok({ transition: action.value, outcome: found, encounterPreview: null });
      }
      const preview = await readVerifiedExpeditionSearchEncounterPreview(client, {
        playerId: input.playerId,
        areaId: action.value.expedition.areaId,
        outcomeId: found.outcomeId,
        encounterId: found.encounterId,
      });
      if (!preview.ok) return preview;
      return ok({ transition: action.value, outcome: found, encounterPreview: preview.value });
    } finally {
      client.release();
    }
  }
}
