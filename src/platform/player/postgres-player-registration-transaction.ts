import type { PoolClient } from "pg";
import {
  type ContentContext,
  type ExternalIdentity,
  type OnboardingRecord,
  OnboardingStateSchema,
  type ProfileInput,
} from "../../modules/player/contracts.js";
import type { StoredProfile } from "../../modules/player/ports.js";
import { type PlayerId, parsePlayerId } from "../../shared-kernel/ids.js";

function asPlayerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error("Database returned an invalid PlayerId");
  return parsed.value;
}

function asMetadata(value: unknown): Readonly<Record<string, never>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Player profile metadata is not an object");
  }
  return value as Readonly<Record<string, never>>;
}

export class PostgresPlayerRegistrationTransaction {
  public constructor(protected readonly client: PoolClient) {}

  public async acquireIdentityLock(identity: ExternalIdentity): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${identity.provider}:${identity.externalId}`,
    ]);
  }

  public async findPlayerByIdentity(identity: ExternalIdentity): Promise<PlayerId | null> {
    const result = await this.client.query<{ player_id: string }>(
      `SELECT player_id FROM player_identities
       WHERE provider = $1 AND external_id = $2 AND status = 'ACTIVE'`,
      [identity.provider, identity.externalId],
    );
    const row = result.rows[0];
    return row === undefined ? null : asPlayerId(row.player_id);
  }

  public async loadActiveContentContext(): Promise<ContentContext | null> {
    const result = await this.client.query<{
      content_release_id: string;
      ruleset_id: string;
    }>(
      `SELECT pointer.content_release_id, release.default_ruleset_id AS ruleset_id
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id = pointer.content_release_id
       JOIN rulesets ruleset ON ruleset.id = release.default_ruleset_id
       WHERE pointer.pointer_key = 'ACTIVE'
         AND release.status = 'PUBLISHED'
         AND ruleset.status = 'PUBLISHED'`,
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { contentReleaseId: row.content_release_id, rulesetId: row.ruleset_id };
  }

  public async createPlayerFoundation(input: {
    readonly playerId: PlayerId;
    readonly identityId: string;
    readonly identity: ExternalIdentity;
    readonly context: ContentContext;
  }): Promise<void> {
    await this.client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [
      input.playerId,
    ]);
    await this.client.query(
      `INSERT INTO player_identities(id, player_id, provider, external_id, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')`,
      [input.identityId, input.playerId, input.identity.provider, input.identity.externalId],
    );
    await this.client.query(
      "INSERT INTO trainer_progression(player_id, level, progression_points) VALUES ($1, 1, 0)",
      [input.playerId],
    );
    await this.client.query("INSERT INTO onboarding_states(player_id, state) VALUES ($1, 'NEW')", [
      input.playerId,
    ]);
    await this.client.query(
      `INSERT INTO player_onboarding_context(player_id, content_release_id, ruleset_id)
       VALUES ($1, $2, $3)`,
      [input.playerId, input.context.contentReleaseId, input.context.rulesetId],
    );
  }

  public async loadOnboarding(playerId: PlayerId, lock = false): Promise<OnboardingRecord | null> {
    if (lock) {
      const locked = await this.client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [
        playerId,
      ]);
      if (locked.rowCount !== 1) return null;
    }
    const result = await this.client.query<{
      player_id: string;
      player_status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
      state: string;
      starter_claim_key: string | null;
      completed_at: Date | null;
      revision: string;
      content_release_id: string;
      ruleset_id: string;
      origin_region_id: string | null;
    }>(
      `SELECT state.player_id, player.status AS player_status, state.state,
              state.starter_claim_key, state.completed_at, state.revision::text,
              context.content_release_id, context.ruleset_id, profile.origin_region_id
       FROM onboarding_states state
       JOIN players player ON player.id = state.player_id
       JOIN player_onboarding_context context ON context.player_id = state.player_id
       LEFT JOIN player_profiles profile ON profile.player_id = state.player_id
       WHERE state.player_id = $1`,
      [playerId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      playerId: asPlayerId(row.player_id),
      playerStatus: row.player_status,
      state: OnboardingStateSchema.parse(row.state),
      starterClaimKey: row.starter_claim_key,
      completedAt: row.completed_at,
      revision: BigInt(row.revision),
      contentReleaseId: row.content_release_id,
      rulesetId: row.ruleset_id,
      originRegionId: row.origin_region_id,
    };
  }

  public async loadProfile(playerId: PlayerId): Promise<StoredProfile | null> {
    const result = await this.client.query<{
      trainer_name: string;
      locale: string | null;
      metadata: unknown;
      origin_region_id: string | null;
    }>(
      `SELECT trainer_name, locale, metadata, origin_region_id
       FROM player_profiles WHERE player_id = $1`,
      [playerId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          trainerName: row.trainer_name,
          locale: row.locale,
          metadata: asMetadata(row.metadata),
          originRegionId: row.origin_region_id,
        };
  }

  public async createProfile(input: {
    readonly playerId: PlayerId;
    readonly profile: ProfileInput;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    const advanced = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'PROFILE_CREATED', revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'NEW' AND revision = $2`,
      [input.playerId, input.expectedRevision.toString()],
    );
    if (advanced.rowCount !== 1) return false;
    await this.client.query(
      `INSERT INTO player_profiles(player_id, trainer_name, locale, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        input.playerId,
        input.profile.trainerName,
        input.profile.locale ?? null,
        JSON.stringify(input.profile.metadata),
      ],
    );
    return true;
  }

  public async regionIsActive(contentReleaseId: string, regionId: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM region_revisions
       WHERE content_release_id = $1 AND region_id = $2 AND active = TRUE`,
      [contentReleaseId, regionId],
    );
    return result.rowCount === 1;
  }

  public async selectRegion(input: {
    readonly playerId: PlayerId;
    readonly regionId: string;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    const advanced = await this.client.query(
      `UPDATE onboarding_states
       SET state = 'REGION_SELECTED', revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND state = 'PROFILE_CREATED' AND revision = $2`,
      [input.playerId, input.expectedRevision.toString()],
    );
    if (advanced.rowCount !== 1) return false;
    const profile = await this.client.query(
      `UPDATE player_profiles
       SET origin_region_id = $2, revision = revision + 1, updated_at = now()
       WHERE player_id = $1`,
      [input.playerId, input.regionId],
    );
    if (profile.rowCount !== 1)
      throw new Error("Player profile disappeared during region selection");
    return true;
  }
}
