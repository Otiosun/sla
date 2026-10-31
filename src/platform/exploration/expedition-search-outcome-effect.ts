import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { ExpeditionSnapshot } from "../../modules/exploration/expedition-state.js";

/**
 * These are persistence categories, NOT new probability weights or an
 * authorization to show a Pokémon. The V4 gameplay policy (still pending)
 * must choose one of these server-side after checking the ACTIVE release.
 */
export type SearchOutcomeKind = "NO_SIGNAL" | "TRAIL" | "INCIDENTAL" | "DIRECT";

export interface SearchOutcomeDecision {
  readonly kind: SearchOutcomeKind;
}

export interface StoredSearchOutcome {
  readonly outcomeId: string;
  readonly playerId: string;
  readonly expeditionId: string;
  readonly expeditionRevision: bigint;
  readonly kind: SearchOutcomeKind;
  readonly encounterId: string | null;
}

/** Only trusted composition, never player-provided labels or WhatsApp payloads. */
export interface SearchOutcomePolicy {
  decide(
    client: PoolClient,
    expedition: ExpeditionSnapshot,
  ): Promise<Result<SearchOutcomeDecision>>;
}

export interface EncounterOutcomeEffect {
  (
    client: PoolClient,
    expedition: ExpeditionSnapshot,
  ): Promise<Result<{ readonly effectRef: string }>>;
}

/**
 * Compose the trusted outcome selection with the canonical EncounterService.
 * This callback must be passed to executeSearchFree(), which owns BEGIN and
 * COMMIT and rejects/rolls back every failed Result. All SQL uses its client.
 *
 * NO_SIGNAL: record factual absence, not a guaranteed spawn or free action.
 * TRAIL: record the category only; trail UX/evidence rules are NOT approved.
 * INCIDENTAL/DIRECT: require a real EncounterService record for this player,
 * current area and currently PUBLISHED release; no fabricated encounter IDs.
 *
 * The durable effectRef is the outcome row id (not an encounter id). It can
 * be read after a WhatsApp replay without regenerating randomness or loot.
 */
export function createSearchOutcomeEffect(deps: {
  readonly policy: SearchOutcomePolicy;
  readonly encounter: EncounterOutcomeEffect;
}): EncounterOutcomeEffect {
  return async (client, expedition) => {
    const selected = await deps.policy.decide(client, expedition);
    if (!selected.ok) return selected;
    const kind = selected.value.kind;
    if (!["NO_SIGNAL", "TRAIL", "INCIDENTAL", "DIRECT"].includes(kind)) {
      return err(appError("ACTION_INVALID", "Unknown authoritative search outcome"));
    }

    let encounterId: string | null = null;
    if (kind === "INCIDENTAL" || kind === "DIRECT") {
      const candidate = await deps.encounter(client, expedition);
      if (!candidate.ok) return candidate;
      const valid = await client.query<{ id: string }>(
        `SELECT encounter.id::text AS id FROM encounters encounter
         JOIN content_release_pointers pointer ON pointer.pointer_key='ACTIVE'
         JOIN content_releases release ON release.id=pointer.content_release_id
           AND release.status='PUBLISHED'
         WHERE encounter.id=$1
           AND encounter.player_id=$2
           AND encounter.area_id=$3
           AND encounter.content_release_id=release.id
           AND encounter.status IN ('CREATED','PRESENTED')`,
        [candidate.value.effectRef, expedition.playerId, expedition.areaId],
      );
      encounterId = valid.rows[0]?.id ?? null;
      if (encounterId === null) {
        return err(
          appError("FLOW_BLOCKED", "Canonical encounter was not persisted in the active release"),
        );
      }
    }

    const outcomeId = randomUUID();
    await client.query(
      `INSERT INTO solo_expedition_search_outcomes(
         id,player_id,expedition_id,expedition_revision,kind,encounter_id
       ) VALUES ($1,$2,$3,$4::bigint,$5,$6)`,
      [
        outcomeId,
        expedition.playerId,
        expedition.expeditionId,
        expedition.revision.toString(),
        kind,
        encounterId,
      ],
    );
    return ok({ effectRef: outcomeId });
  };
}

/** A read-only, player-scoped lookup for the exact result of a replay. */
export async function readStoredSearchOutcome(
  client: PoolClient,
  playerId: string,
  outcomeId: string,
): Promise<StoredSearchOutcome | null> {
  const result = await client.query<{
    id: string;
    player_id: string;
    expedition_id: string;
    expedition_revision: string;
    kind: SearchOutcomeKind;
    encounter_id: string | null;
  }>(
    `SELECT id::text,player_id::text,expedition_id::text,
            expedition_revision::text,kind,encounter_id::text
     FROM solo_expedition_search_outcomes WHERE id=$1 AND player_id=$2`,
    [outcomeId, playerId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        outcomeId: row.id,
        playerId: row.player_id,
        expeditionId: row.expedition_id,
        expeditionRevision: BigInt(row.expedition_revision),
        kind: row.kind,
        encounterId: row.encounter_id,
      };
}
