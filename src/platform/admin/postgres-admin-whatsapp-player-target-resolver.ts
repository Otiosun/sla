import type { Pool } from "pg";

export interface AdminWhatsAppPlayerTarget {
  readonly playerId: string;
  readonly trainerName: string;
}

export interface AdminWhatsAppNameResolution {
  readonly status: "RESOLVED" | "MISSING" | "AMBIGUOUS";
  readonly target?: AdminWhatsAppPlayerTarget;
  readonly candidates?: readonly AdminWhatsAppPlayerTarget[];
}

export class PostgresAdminWhatsAppPlayerTargetResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolveExternalRefs(
    provider: string,
    externalRefs: readonly string[],
  ): Promise<readonly AdminWhatsAppPlayerTarget[]> {
    const refs = [...new Set(externalRefs.map((value) => value.trim()))].filter(
      (value) => value.length > 0,
    );
    if (refs.length === 0) return [];
    const result = await this.pool.query<{
      player_id: string;
      trainer_name: string | null;
      external_id: string;
    }>(
      `SELECT identity.player_id,
              profile.trainer_name,
              identity.external_id
       FROM player_identities identity
       LEFT JOIN player_profiles profile ON profile.player_id = identity.player_id
       WHERE identity.provider = $1
         AND identity.external_id = ANY($2::text[])
         AND identity.status = 'ACTIVE'
       ORDER BY identity.external_id, identity.player_id`,
      [provider, refs],
    );
    return result.rows.map((row) => ({
      playerId: row.player_id,
      trainerName: row.trainer_name?.trim() || "Treinador",
    }));
  }

  public async resolveTrainerName(name: string): Promise<AdminWhatsAppNameResolution> {
    const normalized = name.trim();
    if (normalized.length === 0) return { status: "MISSING" };

    const exact = await this.pool.query<{ player_id: string; trainer_name: string }>(
      `SELECT player.id AS player_id, profile.trainer_name
       FROM player_profiles profile
       JOIN players player ON player.id = profile.player_id
       WHERE lower(btrim(profile.trainer_name)) = lower($1)
       ORDER BY player.created_at, player.id
       LIMIT 3`,
      [normalized],
    );
    if (exact.rows.length === 1) {
      const row = exact.rows[0];
      if (row === undefined) return { status: "MISSING" };
      return {
        status: "RESOLVED",
        target: { playerId: row.player_id, trainerName: row.trainer_name },
      };
    }
    if (exact.rows.length > 1) {
      return {
        status: "AMBIGUOUS",
        candidates: exact.rows.map((row) => ({
          playerId: row.player_id,
          trainerName: row.trainer_name,
        })),
      };
    }

    const prefix = await this.pool.query<{ player_id: string; trainer_name: string }>(
      `SELECT player.id AS player_id, profile.trainer_name
       FROM player_profiles profile
       JOIN players player ON player.id = profile.player_id
       WHERE lower(profile.trainer_name) LIKE lower($1) || '%'
       ORDER BY length(profile.trainer_name), lower(profile.trainer_name), player.created_at
       LIMIT 4`,
      [normalized],
    );
    if (prefix.rows.length === 1) {
      const row = prefix.rows[0];
      if (row === undefined) return { status: "MISSING" };
      return {
        status: "RESOLVED",
        target: { playerId: row.player_id, trainerName: row.trainer_name },
      };
    }
    if (prefix.rows.length > 1) {
      return {
        status: "AMBIGUOUS",
        candidates: prefix.rows.map((row) => ({
          playerId: row.player_id,
          trainerName: row.trainer_name,
        })),
      };
    }
    return { status: "MISSING" };
  }
}
