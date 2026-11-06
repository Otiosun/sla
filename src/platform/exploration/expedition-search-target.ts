import type { PoolClient } from "pg";
/** Older isolated fixtures may omit candidate 0084; they only contain free searches. */
export async function readSearchTarget(
  client: PoolClient,
  outcomeId: string,
): Promise<string | null> {
  const installed = await client.query<{ relation: string | null }>(
    "SELECT to_regclass('public.solo_expedition_search_targets')::text AS relation",
  );
  if (!installed.rows[0]?.relation) return null;
  const found = await client.query<{ species_slug: string }>(
    "SELECT species_slug FROM solo_expedition_search_targets WHERE outcome_id=$1",
    [outcomeId],
  );
  return found.rows[0]?.species_slug ?? null;
}
