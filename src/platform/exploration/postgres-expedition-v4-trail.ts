import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import type { ExpeditionSnapshot } from "../../modules/exploration/expedition-state.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  type EncounterOutcomeEffect,
  readStoredSearchOutcome,
  type StoredSearchOutcome,
} from "./expedition-search-outcome-effect.js";
import { readSearchTarget } from "./expedition-search-target.js";
import type {
  PostgresExpeditionRepository,
  StoredSearchActionTransition,
} from "./postgres-expedition-repository.js";
import {
  readVerifiedExpeditionSearchEncounterPreview,
  type VerifiedExpeditionSearchEncounterPreview,
} from "./postgres-expedition-search-encounter-preview.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface TrailSourceRow {
  readonly id: string;
  readonly fingerprint: string;
}

interface TrailFollowRow {
  readonly id: string;
  readonly player_id: string;
  readonly expedition_id: string;
  readonly source_outcome_id: string;
  readonly followed_outcome_id: string;
  readonly follow_revision: string;
  readonly encounter_id: string;
  readonly content_release_id: string;
  readonly species_name: string;
  readonly encounter_level: number;
  readonly shiny: boolean;
}

/** Source must be the immediately preceding TRAIL from a real, committed
 * ACTION_SEARCH_FREE receipt. No client-chosen target, duplicate or stale hint
 * may authorize an additional 15-minute charge or Encounter. */
async function readVerifiedTrailSource(
  client: PoolClient,
  expedition: ExpeditionSnapshot,
): Promise<Result<string>> {
  if (
    expedition.phase !== "ACTIVE" ||
    expedition.consumedWeekKey === null ||
    expedition.elapsedMinutes < 30 ||
    expedition.elapsedMinutes > 705 ||
    expedition.revision < 1n
  ) {
    return err(appError("FLOW_BLOCKED", "There is no followable trail in this expedition"));
  }
  const found = await client.query<TrailSourceRow>(
    `SELECT source.id::text, receipt.fingerprint
       FROM solo_expedition_search_outcomes source
       JOIN solo_expedition_receipts receipt
         ON receipt.expedition_id=source.expedition_id
        AND receipt.player_id=source.player_id
        AND receipt.operation='ACTION_SEARCH_FREE'
        AND receipt.result->>'effectRef'=source.id::text
       WHERE source.player_id=$1
         AND source.expedition_id=$2
         AND source.expedition_revision=$3::bigint - 1
         AND source.kind='TRAIL'
         AND source.encounter_id IS NULL
         AND receipt.result->'expedition'->>'revision'=$3::text
         AND receipt.result->'expedition'->>'areaId'=$4
         AND receipt.result->'expedition'->>'elapsedMinutes'=$5
         AND NOT EXISTS (
           SELECT 1 FROM solo_expedition_trail_follows followed
           WHERE followed.source_outcome_id=source.id
         )
       LIMIT 2`,
    [
      expedition.playerId,
      expedition.expeditionId,
      expedition.revision.toString(),
      expedition.areaId,
      String(expedition.elapsedMinutes),
    ],
  );
  const source = found.rows[0];
  if (found.rows.length !== 1 || source === undefined || !UUID.test(source.id)) {
    return err(appError("FLOW_BLOCKED", "The latest search has no eligible trail"));
  }
  const target = await readSearchTarget(client, source.id);
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        "ACTION_SEARCH_FREE",
        expedition.expeditionId,
        (expedition.revision - 1n).toString(),
        30,
        ...(target === null ? [] : ["target:" + target]),
      ]),
    )
    .digest("hex");
  if (source.fingerprint !== expected) {
    return err(appError("FLOW_BLOCKED", "Trail source receipt is inconsistent"));
  }
  return ok(source.id);
}

async function readFollow(
  client: PoolClient,
  playerId: PlayerId,
  id: string,
): Promise<TrailFollowRow | null> {
  const found = await client.query<TrailFollowRow>(
    `SELECT follow.id::text,follow.player_id::text,
            follow.expedition_id::text,follow.source_outcome_id::text,
            follow.followed_outcome_id::text,follow.follow_revision::text,
            follow.encounter_id::text,follow.content_release_id::text,
            follow.species_name,follow.encounter_level,follow.shiny
       FROM solo_expedition_trail_follows follow
       JOIN solo_expedition_search_outcomes source
         ON source.id=follow.source_outcome_id
        AND source.kind='TRAIL'
        AND source.encounter_id IS NULL
        AND source.player_id=follow.player_id
        AND source.expedition_id=follow.expedition_id
        AND source.expedition_revision+1=follow.follow_revision
       JOIN solo_expedition_search_outcomes outcome
         ON outcome.id=follow.followed_outcome_id
        AND outcome.kind='DIRECT'
        AND outcome.encounter_id=follow.encounter_id
        AND outcome.player_id=follow.player_id
        AND outcome.expedition_id=follow.expedition_id
        AND outcome.expedition_revision=follow.follow_revision
       JOIN encounters encounter
         ON encounter.id=follow.encounter_id
        AND encounter.player_id=follow.player_id
        AND encounter.content_release_id=follow.content_release_id
       WHERE follow.id=$1 AND follow.player_id=$2`,
    [id, playerId],
  );
  return found.rows.length === 1 ? (found.rows[0] ?? null) : null;
}

export interface ExpeditionV4TrailFollowInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  /** Must come from readPending() or a trusted, server-persisted source. */
  readonly sourceOutcomeId: string;
}

export interface ExpeditionV4TrailFollowResult {
  readonly transition: StoredSearchActionTransition;
  readonly sourceOutcomeId: string;
  readonly outcome: StoredSearchOutcome;
  readonly encounterPreview: VerifiedExpeditionSearchEncounterPreview;
}

/**
 * No independent transaction and no independent Pokémon RNG. The 30-minute
 * TRAIL source, 15-minute follow, new DIRECT outcome and canonical Encounter
 * commit together and can be replayed from immutable receipts. The DIRECT
 * outcome feeds the existing Outbox SENT→engagement→issued capture/PvE menu,
 * while the completion report excludes it from the SEARCH count.
 */
export class PostgresExpeditionV4StagingTrailFollow {
  public constructor(
    private readonly pool: Pool,
    private readonly expedition: Pick<PostgresExpeditionRepository, "executeFollowTrail">,
    private readonly encounter: EncounterOutcomeEffect,
  ) {}

  public async readPending(expedition: ExpeditionSnapshot): Promise<string | null> {
    if (!expeditionOperationAllowed(expedition.playerId)) {
      return null;
    }
    const client = await this.pool.connect();
    try {
      const source = await readVerifiedTrailSource(client, expedition);
      return source.ok ? source.value : null;
    } finally {
      client.release();
    }
  }

  public async execute(
    input: ExpeditionV4TrailFollowInput,
  ): Promise<Result<ExpeditionV4TrailFollowResult>> {
    if (!expeditionOperationAllowed(input.playerId) || !UUID.test(input.sourceOutcomeId)) {
      return err(appError("FLOW_BLOCKED", "Trail following requires isolated development"));
    }
    const action = await this.expedition.executeFollowTrail({
      ...input,
      effect: async (client, persisted) => {
        const source = await readVerifiedTrailSource(client, persisted);
        if (!source.ok) return source;
        if (source.value !== input.sourceOutcomeId) {
          return err(appError("FLOW_BLOCKED", "A different or stale trail was requested"));
        }
        const target = await readSearchTarget(client, source.value);
        const created = await this.encounter(
          client,
          persisted,
          target === null ? undefined : { speciesSlug: target, followTrail: true },
        );
        if (!created.ok) return created;
        if (!UUID.test(created.value.effectRef)) {
          return err(appError("FLOW_BLOCKED", "Canonical encounter was not created"));
        }
        const encounterId = created.value.effectRef;
        const release = await client.query<{ id: string }>(
          `SELECT encounter.content_release_id::text AS id
             FROM encounters encounter
             JOIN content_release_pointers pointer ON pointer.pointer_key='ACTIVE'
             JOIN content_releases release ON release.id=pointer.content_release_id
               AND release.status='PUBLISHED' AND release.published_at IS NOT NULL
             JOIN rulesets ruleset ON ruleset.id=encounter.ruleset_id
               AND ruleset.status='PUBLISHED'
             WHERE encounter.id=$1 AND encounter.player_id=$2
               AND encounter.area_id=$3 AND encounter.content_release_id=release.id
               AND encounter.status IN ('CREATED','PRESENTED')
             LIMIT 2`,
          [encounterId, persisted.playerId, persisted.areaId],
        );
        if (release.rows.length !== 1 || release.rows[0] === undefined) {
          return err(appError("FLOW_BLOCKED", "Trail encounter is not in the published area"));
        }
        // The child DIRECT outcome is a real canonical encounter anchor. It is
        // NOT another 30-minute SEARCH and must be excluded from search totals.
        const outcomeId = randomUUID();
        await client.query(
          `INSERT INTO solo_expedition_search_outcomes
           (id,player_id,expedition_id,expedition_revision,kind,encounter_id)
           VALUES ($1,$2,$3,$4,'DIRECT',$5)`,
          [
            outcomeId,
            persisted.playerId,
            persisted.expeditionId,
            persisted.revision.toString(),
            encounterId,
          ],
        );
        const preview = await readVerifiedExpeditionSearchEncounterPreview(client, {
          playerId: persisted.playerId,
          areaId: persisted.areaId,
          outcomeId,
          encounterId,
        });
        if (!preview.ok) return preview;
        const resultId = randomUUID();
        await client.query(
          `INSERT INTO solo_expedition_trail_follows(
             id,player_id,expedition_id,source_outcome_id,followed_outcome_id,
             follow_revision,encounter_id,content_release_id,
             species_name,encounter_level,shiny)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            resultId,
            persisted.playerId,
            persisted.expeditionId,
            input.sourceOutcomeId,
            outcomeId,
            persisted.revision.toString(),
            encounterId,
            release.rows[0].id,
            preview.value.speciesName,
            preview.value.level,
            preview.value.shiny,
          ],
        );
        const stored = await readFollow(client, input.playerId, resultId);
        if (
          stored === null ||
          stored.source_outcome_id !== input.sourceOutcomeId ||
          stored.encounter_id !== encounterId ||
          stored.followed_outcome_id !== outcomeId
        ) {
          return err(appError("FLOW_BLOCKED", "Trail follow was not durably stored"));
        }
        return ok({ effectRef: resultId });
      },
      sourceOutcomeId: input.sourceOutcomeId,
    });
    if (!action.ok) return action;
    const client = await this.pool.connect();
    try {
      const followed = await readFollow(client, input.playerId, action.value.effectRef);
      if (
        followed === null ||
        followed.expedition_id !== input.expeditionId ||
        followed.source_outcome_id !== input.sourceOutcomeId ||
        BigInt(followed.follow_revision) !== input.expectedRevision ||
        action.value.expedition.expeditionId !== input.expeditionId ||
        action.value.expedition.playerId !== input.playerId ||
        action.value.expedition.revision !== input.expectedRevision + 1n
      ) {
        return err(appError("FLOW_BLOCKED", "Committed trail and action receipt disagree"));
      }
      const outcome = await readStoredSearchOutcome(
        client,
        input.playerId,
        followed.followed_outcome_id,
      );
      if (
        outcome === null ||
        outcome.kind !== "DIRECT" ||
        outcome.encounterId !== followed.encounter_id
      ) {
        return err(
          appError("FLOW_BLOCKED", "Trail follow is missing its canonical encounter outcome"),
        );
      }
      return ok({
        transition: action.value,
        sourceOutcomeId: followed.source_outcome_id,
        outcome,
        encounterPreview: {
          speciesName: followed.species_name,
          level: followed.encounter_level,
          shiny: followed.shiny,
        },
      });
    } finally {
      client.release();
    }
  }
}
