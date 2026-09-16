import type { Pool } from "pg";
import type {
  NarratorSpawnAreaGroup,
  NarratorSpawnContext,
  NarratorSpawnContextResolver,
} from "../../modules/encounter/spawn-whatsapp.js";

interface MemberRow {
  readonly player_id: string;
  readonly trainer_name: string | null;
  readonly area_id: string | null;
  readonly area_display_name: string | null;
}

export class PostgresNarratorSpawnContextResolver implements NarratorSpawnContextResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolve(playerId: string): Promise<NarratorSpawnContext> {
    const party = await this.pool.query<{ party_id: string }>(
      `SELECT member.party_id::text
       FROM player_party_members member
       JOIN player_parties party ON party.id = member.party_id
       WHERE member.player_id = $1
         AND member.active = TRUE
         AND party.active = TRUE`,
      [playerId],
    );

    const partyId = party.rows[0]?.party_id ?? null;
    const members = await this.pool.query<MemberRow>(
      partyId === null
        ? `SELECT player.id::text AS player_id,
                  profile.trainer_name,
                  location.area_id::text,
                  area_revision.display_name AS area_display_name
           FROM players player
           LEFT JOIN player_profiles profile ON profile.player_id = player.id
           LEFT JOIN player_locations location ON location.player_id = player.id
           LEFT JOIN content_release_pointers pointer ON pointer.pointer_key = 'ACTIVE'
           LEFT JOIN area_revisions area_revision
             ON area_revision.content_release_id = pointer.content_release_id
            AND area_revision.area_id = location.area_id
           WHERE player.id = $1`
        : `SELECT player.id::text AS player_id,
                  profile.trainer_name,
                  location.area_id::text,
                  area_revision.display_name AS area_display_name
           FROM player_party_members member
           JOIN player_parties party
             ON party.id = member.party_id
            AND party.active = TRUE
           JOIN players player ON player.id = member.player_id
           LEFT JOIN player_profiles profile ON profile.player_id = player.id
           LEFT JOIN player_locations location ON location.player_id = player.id
           LEFT JOIN content_release_pointers pointer ON pointer.pointer_key = 'ACTIVE'
           LEFT JOIN area_revisions area_revision
             ON area_revision.content_release_id = pointer.content_release_id
            AND area_revision.area_id = location.area_id
           WHERE member.party_id = $1
             AND member.active = TRUE
           ORDER BY player.id`,
      [partyId ?? playerId],
    );

    if (members.rows.length === 0) {
      throw new Error("Narrator spawn target has no resolvable player context");
    }

    const travelling = await this.pool.query<{ trainer_name: string | null }>(
      `SELECT profile.trainer_name
       FROM player_travel_cooldowns cooldown
       JOIN players player ON player.id = cooldown.player_id
       LEFT JOIN player_profiles profile ON profile.player_id = player.id
       WHERE cooldown.player_id = ANY($1::uuid[])
         AND cooldown.reason = 'TRAVEL'
         AND cooldown.available_at > now()
       ORDER BY player.id`,
      [members.rows.map((member) => member.player_id)],
    );

    if (travelling.rows.length > 0) {
      return {
        kind: "TRAVELLING",
        participantDisplayNames: travelling.rows.map(
          (row) => row.trainer_name?.trim() || "Treinador",
        ),
      };
    }

    const byArea = new Map<string, { name: string; players: string[] }>();
    for (const row of members.rows) {
      const areaKey = row.area_id ?? "NO_LOCATION";
      const areaName = row.area_display_name ?? "Sem localização";
      const displayName = row.trainer_name?.trim() || "Treinador";
      const current = byArea.get(areaKey) ?? { name: areaName, players: [] };
      current.players.push(displayName);
      byArea.set(areaKey, current);
    }

    if (byArea.size !== 1 || byArea.has("NO_LOCATION")) {
      const groups: NarratorSpawnAreaGroup[] = [...byArea.values()]
        .map((entry) => ({
          areaDisplayName: entry.name,
          participantDisplayNames: [...entry.players].sort((a, b) => a.localeCompare(b, "pt-BR")),
        }))
        .sort((a, b) => a.areaDisplayName.localeCompare(b.areaDisplayName, "pt-BR"));
      return { kind: "SPLIT", groups };
    }

    const only = [...byArea.values()][0];
    if (only === undefined) throw new Error("Narrator spawn area resolution failed");
    return {
      kind: "READY",
      areaDisplayName: only.name,
      participantCount: members.rows.length,
    };
  }
}
