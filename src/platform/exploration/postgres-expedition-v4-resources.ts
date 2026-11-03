import { createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { EconomyService } from "../../modules/economy/service.js";
import type { ExpeditionSnapshot } from "../../modules/exploration/expedition-state.js";
import { economyRepositoryWithinTransaction } from "../economy/postgres-economy-repository.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import type { PostgresExpeditionRepository, StoredSearchActionTransition } from "./postgres-expedition-repository.js";

const item = z.object({
  kind: z.literal("ITEM"),
  itemId: z.string().uuid(),
  quantity: z.number().int().safe().positive(),
  weight: z.number().int().min(0).max(10_000),
}).strict();
const none = z.object({
  kind: z.literal("NONE"),
  weight: z.number().int().min(0).max(10_000),
}).strict();
const entriesSchema = z.array(z.discriminatedUnion("kind", [item, none])).min(1).max(200);
export type ResourceChoice = z.infer<typeof entriesSchema>[number];

export function choosePublishedResource(entries: unknown, roll: number): Result<ResourceChoice> {
  const parsed = entriesSchema.safeParse(entries);
  if (!parsed.success || !Number.isSafeInteger(roll) || roll < 0 || roll >= 10_000) {
    return err(appError("FLOW_BLOCKED", "Published resource policy is missing or malformed"));
  }
  if (parsed.data.reduce((sum, entry) => sum + entry.weight, 0) !== 10_000) {
    return err(appError("FLOW_BLOCKED", "Resource probabilities are not approved as a complete table"));
  }
  if (new Set(parsed.data.map((entry) => entry.kind === "ITEM" ? entry.itemId : "NONE")).size !== parsed.data.length) {
    return err(appError("FLOW_BLOCKED", "Published resource entries contain duplicate results"));
  }
  let cumulative = 0;
  for (const entry of parsed.data) {
    cumulative += entry.weight;
    if (roll < cumulative) return ok(entry);
  }
  return err(appError("FLOW_BLOCKED", "Invalid resource policy roll"));
}

interface PolicyRow {
  readonly policy_id: string;
  readonly release_id: string;
  readonly entries: unknown;
  readonly approval_ref: string;
}
interface ResourceRow {
  readonly id: string;
  readonly player_id: string;
  readonly expedition_id: string;
  readonly expedition_revision: string;
  readonly content_release_id: string;
  readonly policy_id: string;
  readonly kind: "ITEM" | "NONE";
  readonly item_id: string | null;
  readonly quantity: string;
  readonly ledger_id: string | null;
  readonly item_name: string | null;
}
export interface StoredResourceResult {
  readonly resultId: string;
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expeditionRevision: bigint;
  readonly contentReleaseId: string;
  readonly policyId: string;
  readonly kind: "ITEM" | "NONE";
  readonly itemId: string | null;
  readonly quantity: bigint;
  readonly ledgerId: string | null;
  readonly displayName: string | null;
}
function toResource(row: ResourceRow): StoredResourceResult {
  return {
    resultId: row.id,
    playerId: row.player_id as PlayerId,
    expeditionId: row.expedition_id,
    expeditionRevision: BigInt(row.expedition_revision),
    contentReleaseId: row.content_release_id,
    policyId: row.policy_id,
    kind: row.kind,
    itemId: row.item_id,
    quantity: BigInt(row.quantity),
    ledgerId: row.ledger_id,
    displayName: row.item_name,
  };
}
async function readResource(client: PoolClient, playerId: PlayerId, id: string): Promise<StoredResourceResult | null> {
  const found = await client.query<ResourceRow>(
    `SELECT result.id::text, result.player_id::text, result.expedition_id::text,
            result.expedition_revision::text, result.content_release_id::text,
            result.policy_id::text, result.kind, result.item_id::text,
            result.quantity::text, result.ledger_id::text,
            item.display_name AS item_name
     FROM solo_expedition_resource_results result
     LEFT JOIN item_revisions item ON item.content_release_id=result.content_release_id
       AND item.item_id=result.item_id
     WHERE result.player_id=$1 AND result.id=$2`, [playerId, id],
  );
  return found.rows.length === 1 && found.rows[0] ? toResource(found.rows[0]) : null;
}

/**
 * A missing PUBLISHED, explicitly approved area/period policy always blocks
 * BEFORE spending 60 minutes. A caller cannot supply item IDs or odds.
 */
export class PublishedResourceLootPolicy {
  public constructor(private readonly secret: Uint8Array) {
    if (secret.length < 32) throw new Error("Resource signing secret missing or too short");
  }

  public async decide(
    client: PoolClient,
    expedition: ExpeditionSnapshot,
  ): Promise<Result<{
    readonly policyId: string;
    readonly releaseId: string;
    readonly selection: ResourceChoice;
  }>> {
    if (!["PREPARING", "ACTIVE"].includes(expedition.phase) ||
        !["DAY", "NIGHT"].includes(expedition.period)) {
      return err(appError("FLOW_BLOCKED", "No prepared expedition for resources"));
    }
    const found = await client.query<PolicyRow>(
      `SELECT policy.id::text AS policy_id, release.id::text AS release_id,
              policy.entries, policy.approval_ref
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id=pointer.content_release_id
         AND release.status='PUBLISHED' AND release.published_at IS NOT NULL
       JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id AND ruleset.status='PUBLISHED'
       JOIN area_revisions area ON area.content_release_id=release.id
         AND area.area_id=$1 AND area.active=TRUE
       JOIN solo_resource_loot_policies policy ON policy.content_release_id=release.id
         AND policy.area_id=area.area_id AND policy.period=$2
         AND policy.approved_at <= release.published_at
       WHERE pointer.pointer_key='ACTIVE'`,
      [expedition.areaId, expedition.period],
    );
    const row = found.rows[0];
    if (found.rows.length !== 1 || !row || !z.string().uuid().safeParse(row.policy_id).success ||
        !z.string().uuid().safeParse(row.release_id).success || !row.approval_ref.trim()) {
      return err(appError("FLOW_BLOCKED", "No approved PUBLISHED resource policy for this area"));
    }
    const fields = [
      "solo-expedition-resource-v1", row.release_id, row.policy_id,
      expedition.playerId, expedition.expeditionId, expedition.areaId,
      expedition.period, expedition.revision.toString(),
    ];
    const input = fields.map((value) => value.length + ":" + value).join("|");
    const digest = createHmac("sha256", this.secret).update(input).digest("hex");
    const max = 1n << 256n;
    const modulus = 10_000n;
    const limit = max - max % modulus;
    let draw = BigInt("0x" + digest);
    let attempt = 0;
    while (draw >= limit) {
      if (++attempt > 16) return err(appError("FLOW_BLOCKED", "Resource RNG exhausted"));
      draw = BigInt("0x" + createHmac("sha256", this.secret)
        .update(digest + ":" + attempt).digest("hex"));
    }
    const selection = choosePublishedResource(row.entries, Number(draw % modulus));
    if (!selection.ok) return selection;
    return ok({ policyId: row.policy_id, releaseId: row.release_id, selection: selection.value });
  }
}

export interface ResourceSearchInput {
  readonly playerId: PlayerId;
  readonly expeditionId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
}
export interface ResourceSearchResult {
  readonly transition: StoredSearchActionTransition;
  readonly resource: StoredResourceResult;
}

/** Shared PoolClient makes the expedition cost, canonical EconomyService grant,
 * immutable outcome and Inbox receipt a single rollback-capable PostgreSQL unit. */
export class PostgresExpeditionV4StagingResourceSearch {
  public constructor(
    private readonly pool: Pool,
    private readonly expedition: Pick<PostgresExpeditionRepository, "executeResourceSearch">,
    private readonly policy: PublishedResourceLootPolicy,
  ) {}

  public async execute(input: ResourceSearchInput): Promise<Result<ResourceSearchResult>> {
    if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test" ||
        process.env.WHATSAPP_ENABLED !== "false") {
      return err(appError("FLOW_BLOCKED", "Resources require isolated development"));
    }
    const action = await this.expedition.executeResourceSearch({
      ...input,
      effect: async (client, expedition) => {
        const decision = await this.policy.decide(client, expedition);
        if (!decision.ok) return decision;
        const { selection, policyId, releaseId } = decision.value;
        let ledgerId: string | null = null;
        if (selection.kind === "ITEM") {
          const published = await client.query(
            `SELECT 1 FROM item_revisions item
             JOIN items identity ON identity.id=item.item_id
             WHERE item.content_release_id=$1 AND item.item_id=$2 AND item.active=TRUE`,
            [releaseId, selection.itemId],
          );
          if (published.rowCount !== 1) {
            return err(appError("FLOW_BLOCKED", "Resource item is not active in the published release"));
          }
        }
        const resultId = randomUUID();
        if (selection.kind === "ITEM") {
          const economy = new EconomyService(economyRepositoryWithinTransaction(client));
          const granted = await economy.addItem({
            playerId: input.playerId,
            itemId: selection.itemId,
            quantity: BigInt(selection.quantity),
            idempotencyKey: resultId,
            metadata: {
              sourceType: "EXPEDITION_RESOURCE",
              sourceId: resultId,
              reason: "Approved expedition resource policy " + policyId,
              actorType: "SYSTEM",
              actorId: null,
              correlationId: randomUUID(),
            },
          });
          if (!granted.ok || granted.value.replayed || granted.value.delta !== BigInt(selection.quantity)) {
            return err(appError("FLOW_BLOCKED", "Canonical inventory grant was not committed"));
          }
          ledgerId = granted.value.ledgerId;
        }
        await client.query(
          `INSERT INTO solo_expedition_resource_results
           (id,player_id,expedition_id,expedition_revision,content_release_id,
            policy_id,kind,item_id,quantity,ledger_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            resultId, input.playerId, expedition.expeditionId, expedition.revision.toString(),
            releaseId, policyId, selection.kind,
            selection.kind === "ITEM" ? selection.itemId : null,
            selection.kind === "ITEM" ? selection.quantity : 0, ledgerId,
          ],
        );
        const stored = await readResource(client, input.playerId, resultId);
        if (!stored || stored.expeditionId !== expedition.expeditionId ||
            stored.expeditionRevision !== expedition.revision || stored.policyId !== policyId ||
            (selection.kind === "ITEM" && stored.ledgerId === null)) {
          return err(appError("FLOW_BLOCKED", "Resource result was not durably stored"));
        }
        return ok({ effectRef: resultId });
      },
    });
    if (!action.ok) return action;
    const client = await this.pool.connect();
    try {
      const resource = await readResource(client, input.playerId, action.value.effectRef);
      if (!resource || resource.expeditionId !== input.expeditionId ||
          resource.expeditionRevision !== input.expectedRevision ||
          action.value.expedition.playerId !== input.playerId ||
          action.value.expedition.expeditionId !== input.expeditionId ||
          action.value.expedition.elapsedMinutes < 60) {
        return err(appError("FLOW_BLOCKED", "Resource receipt and persisted result disagree"));
      }
      // A replay must return the original saved item and quantity without granting again.
      return ok({ transition: action.value, resource });
    } finally {
      client.release();
    }
  }
}
