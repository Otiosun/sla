import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { ExpeditionSnapshot } from "../../modules/exploration/expedition-state.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  SearchOutcomeDecision, SearchOutcomeKind, SearchOutcomePolicy,
} from "./expedition-search-outcome-effect.js";

/**
 * The game design has approved the four CATEGORIES, not their probabilities.
 * The runtime MUST NOT supply defaults. A signed-off, PUBLISHED content
 * release needs to carry explicit weights per area + day/night.
 *
 * The table exists only in db/drafts. No WhatsApp handler invokes this policy.
 */
const weightsSchema = z.object({
  NO_SIGNAL: z.number().int().min(0).max(10_000),
  TRAIL: z.number().int().min(0).max(10_000),
  INCIDENTAL: z.number().int().min(0).max(10_000),
  DIRECT: z.number().int().min(0).max(10_000),
}).strict();

export type SearchOutcomeWeights = z.infer<typeof weightsSchema>;
const ORDER = ["NO_SIGNAL", "TRAIL", "INCIDENTAL", "DIRECT"] as const;
const TOTAL = 10_000;

/** Public to allow deterministic, non-production proof without a live DB. */
export function choosePublishedSearchOutcome(
  weights: unknown,
  roll: number,
): Result<SearchOutcomeDecision> {
  const parsed = weightsSchema.safeParse(weights);
  if (!parsed.success || !Number.isSafeInteger(roll) || roll < 0 || roll >= TOTAL) {
    return err(appError("FLOW_BLOCKED", "Published search-outcome policy is invalid"));
  }
  if (ORDER.reduce((sum, kind) => sum + parsed.data[kind], 0) !== TOTAL) {
    return err(appError("FLOW_BLOCKED", "Published search-outcome probabilities are incomplete"));
  }
  let current = 0;
  for (const kind of ORDER) {
    current += parsed.data[kind];
    if (roll < current) return ok({ kind });
  }
  return err(appError("INVALID_STATE_TRANSITION", "Outcome policy roll exceeded weight total"));
}

type PolicyRow = {
  policy_id: string;
  release_id: string;
  weights: unknown;
};

/**
 * HMAC acts only as the independent expedition OUTCOME roll, not as an
 * EncounterService seed or species RNG. No reroll on retry, no RNG from a
 * player/WhatsApp payload. Stable content release + revision + server secret.
 * Provider must keep a pinned non-production secret for fixture tests.
 */
export class PublishedSearchOutcomePolicy implements SearchOutcomePolicy {
  public constructor(private readonly serverSecret: Uint8Array) {
    if (serverSecret.length < 32) {
      throw new Error("Expedition outcome signing key is missing or too short");
    }
  }

  public async decide(
    client: PoolClient,
    expedition: ExpeditionSnapshot,
  ): Promise<Result<SearchOutcomeDecision>> {
    if (!["DAY", "NIGHT"].includes(expedition.period) ||
        !["PREPARING", "ACTIVE"].includes(expedition.phase) ||
        expedition.revision < 0n) {
      return err(appError("FLOW_BLOCKED", "No eligible expedition for outcome selection"));
    }
    const policies = await client.query<PolicyRow>(
      `SELECT policy.id::text AS policy_id, release.id::text AS release_id,
              policy.weights
       FROM content_release_pointers pointer
       JOIN content_releases release
         ON release.id=pointer.content_release_id AND release.status='PUBLISHED'
       JOIN area_revisions area
         ON area.content_release_id=release.id
        AND area.area_id=$1 AND area.active=TRUE
       JOIN solo_search_outcome_policies policy
         ON policy.content_release_id=release.id
        AND policy.area_id=area.area_id AND policy.period=$2
       WHERE pointer.pointer_key='ACTIVE'`,
      [expedition.areaId, expedition.period],
    );
    if (policies.rows.length !== 1) {
      return err(appError("FLOW_BLOCKED", "No approved published search-outcome policy for this area"));
    }
    const row = policies.rows[0];
    if (!row || !z.string().uuid().safeParse(row.policy_id).success ||
        !z.string().uuid().safeParse(row.release_id).success) {
      return err(appError("FLOW_BLOCKED", "Invalid published outcome-policy reference"));
    }
    const fields = [
      "solo-expedition-search-outcome-v1", row.release_id, row.policy_id,
      expedition.playerId, expedition.expeditionId, expedition.areaId,
      expedition.period, expedition.revision.toString(),
    ];
    const digest = createHmac("sha256", this.serverSecret)
      .update(fields.map(s => s.length + ":" + s).join("|"), "utf8")
      .digest("hex");
    // 256-bit rejection sampling avoids a modulo bias even in theory.
    const max = 1n << 256n;
    const total = BigInt(TOTAL);
    const limit = max - (max % total);
    let value = BigInt("0x" + digest);
    let attempt = 0;
    while (value >= limit) {
      attempt++;
      if (attempt > 16) {
        return err(appError("FLOW_BLOCKED", "Outcome RNG could not draw a safe sample"));
      }
      value = BigInt("0x" + createHmac("sha256", this.serverSecret)
        .update(digest + ":" + attempt, "utf8").digest("hex"));
    }
    return choosePublishedSearchOutcome(row.weights, Number(value % total));
  }
}
