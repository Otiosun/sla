import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { buildZhouliaDirectedRoutes } from "../../modules/world/zhoulia-catalog-adapter.js";
import { ZHOULIA_TYPED_CONTENT_V1 } from "../../modules/world/zhoulia-content.js";

const approval = "owner:exploration-v4:A-E";
export const approvedSearchWeights = {
  NO_SIGNAL: 5000,
  TRAIL: 2500,
  INCIDENTAL: 1500,
  DIRECT: 1000,
};

export function approvedLoot(ball: string, potion: string) {
  return [
    { kind: "NONE", weight: 7500 },
    { kind: "ITEM", itemId: ball, quantity: 1, weight: 1500 },
    { kind: "ITEM", itemId: potion, quantity: 1, weight: 700 },
    { kind: "ITEM", itemId: ball, quantity: 2, weight: 200 },
    { kind: "ITEM", itemId: potion, quantity: 2, weight: 100 },
  ];
}

export function approvedReportRewards(currencyId: string, ball: string, potion: string) {
  const money = (amount: string) => ({ kind: "MONEY", currencyId, amount });
  const item = (itemId: string) => ({ kind: "ITEM", itemId, quantity: "1" });
  const points = (amount: number) => ({ kind: "TRAINER_POINTS", amount });
  return {
    base: [money("300")],
    normal: [
      { weight: 4500, reward: money("200") },
      { weight: 3000, reward: item(ball) },
      { weight: 1500, reward: item(potion) },
      { weight: 1000, reward: points(50) },
    ],
    highlight: [
      { weight: 6000, reward: money("100") },
      { weight: 2500, reward: item(ball) },
      { weight: 1000, reward: item(potion) },
      { weight: 500, reward: points(25) },
    ],
  };
}

/** Called inside the candidate materializer's locked DRAFT transaction. */
export async function writeApprovedV4Policies(
  client: PoolClient,
  releaseId: string,
  areaIds: readonly string[],
): Promise<void> {
  const { rows } = await client.query<{ slug: string; id: string }>(
    `SELECT item.slug, item.id FROM items item JOIN item_revisions revision
       ON revision.item_id=item.id AND revision.content_release_id=$1 AND revision.active
       WHERE item.slug IN ('poke-ball','potion')`,
    [releaseId],
  );
  const ball = rows.find((row) => row.slug === "poke-ball")?.id;
  const potion = rows.find((row) => row.slug === "potion")?.id;
  const currency = (
    await client.query<{ id: string }>(
      "SELECT id FROM currency_definitions WHERE slug='pokedollar'",
    )
  ).rows[0]?.id;
  if (!ball || !potion || !currency) throw new Error("Canonical V4 reward assets are incomplete");

  for (const areaId of areaIds) {
    for (const period of ["DAY", "NIGHT"]) {
      await client.query(
        `INSERT INTO solo_search_outcome_policies(id,content_release_id,area_id,period,weights)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(content_release_id,area_id,period)
         DO UPDATE SET weights=EXCLUDED.weights`,
        [randomUUID(), releaseId, areaId, period, JSON.stringify(approvedSearchWeights)],
      );
      await client.query(
        `INSERT INTO solo_resource_loot_policies(id,content_release_id,area_id,period,entries,approval_ref,approved_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT(content_release_id,area_id,period)
         DO UPDATE SET entries=EXCLUDED.entries,approval_ref=EXCLUDED.approval_ref,approved_at=EXCLUDED.approved_at`,
        [
          randomUUID(),
          releaseId,
          areaId,
          period,
          JSON.stringify(approvedLoot(ball, potion)),
          approval,
        ],
      );
    }
  }

  await client.query(
    `INSERT INTO solo_report_reward_policies(content_release_id,config,approval_ref,approved_at)
     VALUES($1,$2::jsonb,$3,now()) ON CONFLICT(content_release_id)
     DO UPDATE SET config=EXCLUDED.config,approval_ref=EXCLUDED.approval_ref,approved_at=EXCLUDED.approved_at`,
    [releaseId, JSON.stringify(approvedReportRewards(currency, ball, potion)), approval],
  );
  const routes = buildZhouliaDirectedRoutes(ZHOULIA_TYPED_CONTENT_V1);
  const updated = await client.query(
    `UPDATE area_connection_revisions revision
     SET access_rule=jsonb_set(revision.access_rule,'{explorationMinutes}','30')
     FROM area_connections connection
     WHERE revision.connection_id=connection.id AND revision.content_release_id=$1
       AND revision.active AND connection.connection_key=ANY($2::text[])
       AND connection.from_area_id=ANY($3::uuid[]) AND connection.to_area_id=ANY($3::uuid[])`,
    [releaseId, routes.map((route) => route.connectionKey), areaIds],
  );
  if (updated.rowCount !== routes.length)
    throw new Error("Both approved Zhoulia directions are required");
}
