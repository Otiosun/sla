import type { Pool, PoolClient } from "pg";
import {
  ConnectionAccessRuleSchema,
  WorldAreaConfigSchema,
} from "../../modules/catalog/world-contracts.js";
import type {
  PlayerLocationRecord,
  WorldAreaRecord,
  WorldConnectionRecord,
  WorldFlowState,
  WorldPlayerEligibility,
} from "../../modules/world/contracts.js";
import type { WorldRepository, WorldTransaction } from "../../modules/world/ports.js";
import { parsePlayerId, type PlayerId } from "../../shared-kernel/ids.js";
import { withTransaction } from "../db/transaction.js";

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function mapArea(row: {
  area_id: string;
  area_slug: string;
  area_display_name: string;
  region_id: string;
  region_slug: string;
  region_display_name: string;
  active: boolean;
  data: unknown;
}): WorldAreaRecord {
  const config = WorldAreaConfigSchema.safeParse(row.data);
  if (!config.success) {
    throw new Error(`Published area ${row.area_id} has invalid world config`);
  }
  return {
    areaId: row.area_id,
    areaSlug: row.area_slug,
    areaDisplayName: row.area_display_name,
    regionId: row.region_id,
    regionSlug: row.region_slug,
    regionDisplayName: row.region_display_name,
    active: row.active,
    config: config.data,
  };
}

function mapConnection(row: {
  connection_id: string;
  connection_key: string;
  from_area_id: string;
  to_area_id: string;
  active: boolean;
  access_rule: unknown;
}): WorldConnectionRecord {
  const rule = ConnectionAccessRuleSchema.safeParse(row.access_rule);
  if (!rule.success) {
    throw new Error(`Published connection ${row.connection_id} has invalid access rule`);
  }
  return {
    connectionId: row.connection_id,
    connectionKey: row.connection_key,
    fromAreaId: row.from_area_id,
    toAreaId: row.to_area_id,
    active: row.active,
    accessRule: rule.data,
  };
}

const AREA_SELECT = `
  SELECT area.id AS area_id,
         area.slug AS area_slug,
         area_revision.display_name AS area_display_name,
         region.id AS region_id,
         region.slug AS region_slug,
         region_revision.display_name AS region_display_name,
         area_revision.active,
         area_revision.data
  FROM areas area
  JOIN area_revisions area_revision
    ON area_revision.area_id = area.id
   AND area_revision.content_release_id = $1
  JOIN regions region ON region.id = area.region_id
  JOIN region_revisions region_revision
    ON region_revision.region_id = region.id
   AND region_revision.content_release_id = $1
`;

class PostgresWorldTransaction implements WorldTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async activeContentReleaseId(): Promise<string | null> {
    const result = await this.client.query<{ content_release_id: string }>(
      `SELECT content_release_id
       FROM content_release_pointers
       WHERE pointer_key = 'ACTIVE'`,
    );
    return result.rows[0]?.content_release_id ?? null;
  }

  public async playerEligibility(player: PlayerId): Promise<WorldPlayerEligibility | null> {
    const result = await this.client.query<{
      status: string;
      onboarding_state: string | null;
      origin_region_id: string | null;
    }>(
      `SELECT p.status,
              onboarding.state AS onboarding_state,
              profile.origin_region_id
       FROM players p
       LEFT JOIN onboarding_states onboarding ON onboarding.player_id = p.id
       LEFT JOIN player_profiles profile ON profile.player_id = p.id
       WHERE p.id = $1`,
      [player],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      playerActive: row.status === "ACTIVE",
      onboardingComplete: row.onboarding_state === "COMPLETE",
      originRegionId: row.origin_region_id,
    };
  }

  public async playerLocation(
    player: PlayerId,
    lock = false,
  ): Promise<PlayerLocationRecord | null> {
    const result = await this.client.query<{
      player_id: string;
      area_id: string;
      entered_at: Date;
      revision: string;
    }>(
      `SELECT player_id, area_id, entered_at, revision::text
       FROM player_locations
       WHERE player_id = $1
       ${lock ? "FOR UPDATE" : ""}`,
      [player],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      playerId: playerId(row.player_id),
      areaId: row.area_id,
      enteredAt: row.entered_at,
      revision: BigInt(row.revision),
    };
  }

  public async insertInitialLocation(player: PlayerId, areaId: string): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO player_locations(player_id, area_id)
       VALUES ($1, $2)
       ON CONFLICT (player_id) DO NOTHING`,
      [player, areaId],
    );
    return result.rowCount === 1;
  }

  public async moveLocation(input: {
    readonly playerId: PlayerId;
    readonly destinationAreaId: string;
    readonly expectedRevision: bigint;
  }): Promise<PlayerLocationRecord | null> {
    const result = await this.client.query<{
      player_id: string;
      area_id: string;
      entered_at: Date;
      revision: string;
    }>(
      `UPDATE player_locations
       SET area_id = $2,
           entered_at = now(),
           revision = revision + 1
       WHERE player_id = $1 AND revision = $3::bigint
       RETURNING player_id, area_id, entered_at, revision::text`,
      [input.playerId, input.destinationAreaId, input.expectedRevision.toString()],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      playerId: playerId(row.player_id),
      areaId: row.area_id,
      enteredAt: row.entered_at,
      revision: BigInt(row.revision),
    };
  }

  public async area(contentReleaseId: string, areaId: string): Promise<WorldAreaRecord | null> {
    const result = await this.client.query<{
      area_id: string;
      area_slug: string;
      area_display_name: string;
      region_id: string;
      region_slug: string;
      region_display_name: string;
      active: boolean;
      data: unknown;
    }>(`${AREA_SELECT} WHERE area.id = $2`, [contentReleaseId, areaId]);
    const row = result.rows[0];
    return row === undefined ? null : mapArea(row);
  }

  public async areasInRegion(
    contentReleaseId: string,
    regionId: string,
  ): Promise<readonly WorldAreaRecord[]> {
    const result = await this.client.query<{
      area_id: string;
      area_slug: string;
      area_display_name: string;
      region_id: string;
      region_slug: string;
      region_display_name: string;
      active: boolean;
      data: unknown;
    }>(`${AREA_SELECT} WHERE region.id = $2 ORDER BY area.id`, [contentReleaseId, regionId]);
    return result.rows.map(mapArea);
  }

  public async connectionsFrom(
    contentReleaseId: string,
    areaId: string,
  ): Promise<readonly WorldConnectionRecord[]> {
    const result = await this.client.query<{
      connection_id: string;
      connection_key: string;
      from_area_id: string;
      to_area_id: string;
      active: boolean;
      access_rule: unknown;
    }>(
      `SELECT connection.id AS connection_id,
              connection.connection_key,
              connection.from_area_id,
              connection.to_area_id,
              revision.active,
              revision.access_rule
       FROM area_connections connection
       JOIN area_connection_revisions revision
         ON revision.connection_id = connection.id
        AND revision.content_release_id = $1
       WHERE connection.from_area_id = $2
       ORDER BY connection.connection_key, connection.id`,
      [contentReleaseId, areaId],
    );
    return result.rows.map(mapConnection);
  }

  public async connectionBetween(
    contentReleaseId: string,
    fromAreaId: string,
    toAreaId: string,
  ): Promise<WorldConnectionRecord | null> {
    const result = await this.client.query<{
      connection_id: string;
      connection_key: string;
      from_area_id: string;
      to_area_id: string;
      active: boolean;
      access_rule: unknown;
    }>(
      `SELECT connection.id AS connection_id,
              connection.connection_key,
              connection.from_area_id,
              connection.to_area_id,
              revision.active,
              revision.access_rule
       FROM area_connections connection
       JOIN area_connection_revisions revision
         ON revision.connection_id = connection.id
        AND revision.content_release_id = $1
       WHERE connection.from_area_id = $2 AND connection.to_area_id = $3
       ORDER BY connection.connection_key, connection.id
       LIMIT 1`,
      [contentReleaseId, fromAreaId, toAreaId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapConnection(row);
  }

  public async activeFlowState(player: PlayerId): Promise<WorldFlowState> {
    const result = await this.client.query<{
      encounter_active: boolean;
      battle_active: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM encounters encounter
           WHERE encounter.player_id = $1
             AND encounter.status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE')
         ) AS encounter_active,
         EXISTS (
           SELECT 1
           FROM battle_sides side
           JOIN battles battle ON battle.id = side.battle_id
           WHERE side.player_id = $1
             AND battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
         ) AS battle_active`,
      [player],
    );
    return result.rows[0] ?? { encounter_active: false, battle_active: false };
  }

  public async activeUnlockKeys(player: PlayerId): Promise<readonly string[]> {
    const result = await this.client.query<{ unlock_key: string }>(
      `SELECT unlock_key
       FROM trainer_unlocks
       WHERE player_id = $1 AND status = 'ACTIVE'
       ORDER BY unlock_key`,
      [player],
    );
    return result.rows.map((row) => row.unlock_key);
  }
}

export class PostgresWorldRepository implements WorldRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (transaction: WorldTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresWorldTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (transaction: WorldTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresWorldTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
