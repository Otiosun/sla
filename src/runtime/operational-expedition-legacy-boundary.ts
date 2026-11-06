import type { Pool } from "pg";

export class OperationalExpeditionLegacyBoundary {
  private schema: Promise<boolean> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly players: ReadonlySet<string>,
  ) {}

  private hasSchema(): Promise<boolean> {
    this.schema ??= this.pool
      .query<{ available: boolean }>(
        "SELECT to_regclass('solo_expedition_fishing_encounters') IS NOT NULL AND to_regclass('solo_expedition_search_outcomes') IS NOT NULL AS available",
      )
      .then((result) => result.rows[0]?.available === true)
      .catch((error) => {
        this.schema = undefined;
        throw error;
      });
    return this.schema;
  }

  async permitsBattle(battleId: string): Promise<boolean> {
    if (!(await this.hasSchema())) return true;
    const linked = await this.pool.query<{ player_id: string; active: boolean }>(
      `SELECT owner.player_id, EXISTS(SELECT 1 FROM player_access a JOIN players p ON p.id=a.player_id
          WHERE a.player_id=owner.player_id AND a.status='ACTIVE' AND p.status='ACTIVE') AS active
       FROM battles b JOIN (
         SELECT encounter_id,player_id FROM solo_expedition_search_outcomes WHERE encounter_id IS NOT NULL
         UNION SELECT encounter_id,player_id FROM solo_expedition_fishing_encounters
       ) owner ON owner.encounter_id=b.encounter_id WHERE b.id=$1`,
      [battleId],
    );
    return linked.rows.every(({ player_id, active }) => active && this.players.has(player_id));
  }

  async hasOpenV4Subject(playerId: string): Promise<boolean> {
    if (!(await this.hasSchema())) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM encounters encounter
       WHERE encounter.player_id=$1 AND encounter.status IN ('CREATED','PRESENTED','ENGAGED','CAPTURE_RESOLVING','IN_BATTLE')
         AND (EXISTS(SELECT 1 FROM solo_expedition_search_outcomes WHERE encounter_id=encounter.id)
           OR EXISTS(SELECT 1 FROM solo_expedition_fishing_encounters WHERE encounter_id=encounter.id))
       UNION ALL
       SELECT 1 FROM world_service_sessions WHERE player_id=$1 AND expedition_id IS NOT NULL AND state='OPEN'
       LIMIT 1`,
      [playerId],
    );
    return result.rowCount !== 0;
  }

  async isExpeditionQuote(sender: string, quote: string): Promise<boolean> {
    if (!/^[a-f0-9]{32}$/iu.test(quote)) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM outbox_messages
       WHERE channel='whatsapp' AND destination_ref=$1
         AND id=$2::uuid
         AND payload ?| ARRAY['expeditionAudience','expeditionNavigation','expeditionSearch','expeditionMenu']`,
      [sender, quote],
    );
    return result.rowCount === 1;
  }
}
