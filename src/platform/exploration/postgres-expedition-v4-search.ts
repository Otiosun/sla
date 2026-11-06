import type { Pool } from "pg";
import { resolveSearchEntries } from "../../modules/encounter/search-entries.js";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { encounterRepositoryWithinTransaction } from "../encounter/postgres-encounter-repository.js";
import {
  createSearchOutcomeEffect,
  type EncounterOutcomeEffect,
  readStoredSearchOutcome,
  type SearchOutcomePolicy,
  type StoredSearchOutcome,
} from "./expedition-search-outcome-effect.js";
import type {
  PostgresExpeditionRepository,
  StoredSearchActionTransition,
} from "./postgres-expedition-repository.js";
import {
  readCommittedExpeditionSearchEncounter,
  readVerifiedExpeditionSearchEncounterPreview,
  type VerifiedExpeditionSearchEncounterPreview,
} from "./postgres-expedition-search-encounter-preview.js";

export interface ExpeditionV4StagingSearchInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  readonly targetSpeciesSlug?: string;
}

export interface ExpeditionV4StagingSearchResult {
  readonly transition: StoredSearchActionTransition;
  readonly outcome: StoredSearchOutcome;
  readonly encounterPreview: VerifiedExpeditionSearchEncounterPreview | null;
  readonly historical?: boolean;
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

  public async recover(
    playerId: PlayerId,
    context: MessageHandlerContext,
    targetSpeciesSlug?: string,
  ): Promise<Result<ExpeditionV4StagingSearchResult | null>> {
    if (!expeditionOperationAllowed(playerId) || context.message.provider !== "baileys")
      return ok(null);
    const message =
      context.expeditionNavigationAuthorization === undefined
        ? context.message
        : {
            ...context.message,
            chatRef: context.message.senderRef,
            text: context.originalMessageText ?? null,
          };
    const found = await this.pool.query<{
      expedition_id: string | null;
      revision: string | null;
      attempts: number;
    }>(
      `SELECT receipt.expedition_id, outcome.expedition_revision::text AS revision, inbox.attempts
       FROM inbox_messages inbox
       JOIN player_identities identity ON identity.provider=inbox.provider
         AND identity.external_id=$4 AND identity.player_id=$2 AND identity.status='ACTIVE'
       LEFT JOIN solo_expedition_receipts receipt ON receipt.player_id=identity.player_id
         AND receipt.idempotency_key=$3 AND receipt.operation='ACTION_SEARCH_FREE'
       LEFT JOIN solo_expedition_search_outcomes outcome ON outcome.id::text=receipt.result->>'effectRef'
         AND outcome.player_id=receipt.player_id AND outcome.expedition_id=receipt.expedition_id
       WHERE inbox.id=$1 AND inbox.status='PROCESSING' AND inbox.provider='baileys'
         AND (inbox.player_id IS NULL OR inbox.player_id=identity.player_id)
         AND inbox.payload_hash=$5 AND inbox.external_message_id=$6
         AND inbox.normalized_payload->>'senderRef'=$4 AND inbox.normalized_payload->>'chatRef'=$7`,
      [
        context.inboxMessageId,
        playerId,
        context.idempotencyKey,
        message.senderRef,
        incomingMessageFingerprint(message),
        message.externalMessageId,
        message.chatRef,
      ],
    );
    const receipt = found.rows[0];
    if (!receipt)
      return err(
        appError("FLOW_BLOCKED", "Search Inbox proof did not match", {
          userMessage: "Busca não confirmada. Consulte /explorar status.",
        }),
      );
    if (receipt.expedition_id === null && receipt.attempts === 1) return ok(null);
    if (receipt.expedition_id === null || receipt.revision === null)
      return err(
        appError("FLOW_BLOCKED", "Search lacks a committed receipt", {
          userMessage: "Busca não confirmada. Consulte /explorar status.",
        }),
      );
    return this.resolve(
      {
        playerId,
        idempotencyKey: context.idempotencyKey,
        expeditionId: receipt.expedition_id,
        expectedRevision: BigInt(receipt.revision),
        ...(targetSpeciesSlug === undefined ? {} : { targetSpeciesSlug }),
      },
      true,
    );
  }

  public async execute(
    input: ExpeditionV4StagingSearchInput,
  ): Promise<Result<ExpeditionV4StagingSearchResult>> {
    return this.resolve(input, false);
  }

  private async resolve(
    input: ExpeditionV4StagingSearchInput,
    replayOnly: boolean,
  ): Promise<Result<ExpeditionV4StagingSearchResult>> {
    const effect = createSearchOutcomeEffect({
      ...(input.targetSpeciesSlug === undefined
        ? {}
        : { targetSpeciesSlug: input.targetSpeciesSlug }),
      policy: this.policy,
      encounter: this.encounter,
    });
    const action = await this.expedition.executeSearchFree({
      ...input,
      replayOnly,
      ...(input.targetSpeciesSlug === undefined
        ? {}
        : { semanticKey: "target:" + input.targetSpeciesSlug }),
      effect: async (client, persisted) => {
        // Validate even NO_SIGNAL/TRAIL before any time, quota or outcome is committed.
        const targetSpeciesSlug = input.targetSpeciesSlug;
        if (targetSpeciesSlug !== undefined) {
          const checked = await encounterRepositoryWithinTransaction(client).read(async (tx) => {
            const content = await tx.activeContent();
            const context = await tx.playerContext(input.playerId, true);
            if (content === null || context === null || context.areaId !== persisted.areaId) {
              return err(appError("FLOW_BLOCKED", "Search location or content is unavailable"));
            }
            return resolveSearchEntries(tx, content.contentReleaseId, context, {
              playerId: input.playerId,
              idempotencyKey: input.idempotencyKey,
              searchTarget: { speciesSlug: targetSpeciesSlug },
              environment: { timeOfDay: persisted.period, surface: "LAND" },
            });
          });
          if (!checked.ok) return checked;
        }
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
      const preview = await readCommittedExpeditionSearchEncounter(client, {
        playerId: input.playerId,
        areaId: action.value.expedition.areaId,
        outcomeId: found.outcomeId,
        encounterId: found.encounterId,
      });
      if (!preview.ok) return preview;
      return ok({
        transition: action.value,
        outcome: found,
        encounterPreview: preview.value.preview,
        historical: !preview.value.actionable,
      });
    } finally {
      client.release();
    }
  }
}
