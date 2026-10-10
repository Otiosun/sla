import type { Pool, PoolClient } from "pg";
import {
  COMPETITIVE_ACTIVITY_ACTIVE_WINDOW_MS,
  COMPETITIVE_ACTIVITY_REPEAT_WINDOW_MS,
  type CompetitiveSpawnActivityObservation,
  type CompetitiveSpawnActivityRepository,
  competitiveActivityCreditMilli,
  competitiveActivityDecayedProgressMilli,
  competitiveActivityIdleAssistRoll,
  competitiveActivityMonotoneTargetMilli,
  competitiveActivityTargetMilli,
  competitiveIncenseTargetMilli,
} from "../../modules/competitive-spawn/activity.js";
import { withTransaction } from "../db/transaction.js";

interface ActivityStateRow {
  readonly progress_milli: number;
  readonly target_roll: number | null;
  readonly target_milli: number | null;
  readonly cycle_no: string | number | bigint;
  readonly last_activity_at: Date | null;
  readonly last_player_id: string | null;
  readonly sender_streak: number;
}

interface ActivitySenderRow {
  readonly last_message_at: Date;
  readonly last_fingerprint: string | null;
  readonly last_fingerprint_at: Date | null;
}

async function activeParticipants(client: PoolClient, groupId: string, now: Date): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM competitive_spawn_activity_senders
     WHERE community_group_id = $1
       AND active_at >= $2`,
    [groupId, new Date(now.getTime() - COMPETITIVE_ACTIVITY_ACTIVE_WINDOW_MS)],
  );
  const count = Number(result.rows[0]?.count ?? "0");
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function observation(input: {
  readonly progressMilli: number;
  readonly targetRoll: number | null;
  readonly targetMilli: number | null;
  readonly activeParticipants: number;
  readonly creditedMilli: number;
  readonly frozen: "ACTIVE_SPAWN" | "COOLDOWN" | null;
}): CompetitiveSpawnActivityObservation {
  const participantCount = Math.max(1, input.activeParticipants);
  return {
    progressMilli: input.progressMilli,
    targetMilli:
      input.targetRoll === null
        ? null
        : (input.targetMilli ?? competitiveActivityTargetMilli(participantCount, input.targetRoll)),
    activeParticipants: input.activeParticipants,
    creditedMilli: input.creditedMilli,
    frozen: input.frozen,
  };
}

async function effectiveState(
  client: PoolClient,
  groupId: string,
  now: Date,
): Promise<CompetitiveSpawnActivityObservation> {
  const state = await client.query<ActivityStateRow>(
    `SELECT progress_milli, target_roll, target_milli, cycle_no, last_activity_at, last_player_id, sender_streak
     FROM competitive_spawn_activity_state
     WHERE community_group_id = $1`,
    [groupId],
  );
  const row = state.rows[0];
  const participants = await activeParticipants(client, groupId, now);
  if (row === undefined) {
    return observation({
      progressMilli: 0,
      targetRoll: null,
      targetMilli: null,
      activeParticipants: participants,
      creditedMilli: 0,
      frozen: null,
    });
  }
  const decayed = competitiveActivityDecayedProgressMilli(
    row.progress_milli,
    row.last_activity_at,
    now,
  );
  return observation({
    progressMilli: decayed.progressMilli,
    targetRoll: row.target_roll,
    targetMilli: row.target_milli,
    activeParticipants: participants,
    creditedMilli: 0,
    frozen: null,
  });
}

export class PostgresCompetitiveSpawnActivityRepository
  implements CompetitiveSpawnActivityRepository
{
  public constructor(private readonly pool: Pool) {}

  public async stateForGroup(
    groupId: string,
    now: Date,
  ): Promise<CompetitiveSpawnActivityObservation> {
    const client = await this.pool.connect();
    try {
      return await effectiveState(client, groupId, now);
    } finally {
      client.release();
    }
  }

  public async observe(input: {
    readonly communityGroupId: string;
    readonly provider: string;
    readonly externalMessageId: string;
    readonly playerId: string;
    readonly senderRef: string;
    readonly fingerprint: string;
    readonly baseWeightMilli: number;
    readonly targetRoll: number;
    readonly incenseActive?: boolean;
    readonly now: Date;
    readonly cooldownMs: number;
  }): Promise<CompetitiveSpawnActivityObservation> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `competitive-spawn-activity:${input.communityGroupId}`,
      ]);

      const duplicate = await client.query<{ credited_milli: number }>(
        `SELECT credited_milli
         FROM competitive_spawn_activity_receipts
         WHERE provider = $1 AND external_message_id = $2`,
        [input.provider, input.externalMessageId],
      );
      if (duplicate.rows[0] !== undefined) {
        return effectiveState(client, input.communityGroupId, input.now);
      }

      const openSpawn = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM competitive_spawns
           WHERE community_group_id = $1
             AND status = 'OPEN'
         ) AS active`,
        [input.communityGroupId],
      );
      const recentPublished = await client.query<{
        status: "OPEN" | "WON" | "EXPIRED" | "CANCELLED";
        published_at: Date;
        expires_at: Date;
        resolved_at: Date | null;
      }>(
        `SELECT status, published_at, expires_at, resolved_at
         FROM competitive_spawns
         WHERE community_group_id = $1
           AND published_at IS NOT NULL
         ORDER BY opened_at DESC
         LIMIT 1`,
        [input.communityGroupId],
      );
      const isActive = openSpawn.rows[0]?.active === true;
      const latestPublished = recentPublished.rows[0];
      const cooldownAnchor =
        latestPublished === undefined
          ? null
          : latestPublished.status === "OPEN"
            ? latestPublished.expires_at
            : (latestPublished.resolved_at ?? latestPublished.published_at);
      const inCooldown =
        !isActive &&
        cooldownAnchor !== null &&
        input.now.getTime() - cooldownAnchor.getTime() < input.cooldownMs;

      if (isActive || inCooldown) {
        await client.query(
          `INSERT INTO competitive_spawn_activity_receipts(
             provider, external_message_id, community_group_id, player_id,
             sender_ref, credited_milli, occurred_at
           ) VALUES ($1, $2, $3, $4, $5, 0, $6)
           ON CONFLICT (provider, external_message_id) DO NOTHING`,
          [
            input.provider,
            input.externalMessageId,
            input.communityGroupId,
            input.playerId,
            input.senderRef,
            input.now,
          ],
        );
        const current = await effectiveState(client, input.communityGroupId, input.now);
        return { ...current, frozen: isActive ? "ACTIVE_SPAWN" : "COOLDOWN" };
      }

      let state = await client.query<ActivityStateRow>(
        `SELECT progress_milli, target_roll, target_milli, cycle_no, last_activity_at, last_player_id, sender_streak
         FROM competitive_spawn_activity_state
         WHERE community_group_id = $1
         FOR UPDATE`,
        [input.communityGroupId],
      );
      if (state.rows[0] === undefined) {
        await client.query(
          `INSERT INTO competitive_spawn_activity_state(
             community_group_id, progress_milli, target_roll, cycle_no,
             last_activity_at, last_player_id, sender_streak, updated_at
           ) VALUES ($1, 0, $2, 0, NULL, NULL, 0, $3)`,
          [input.communityGroupId, input.targetRoll, input.now],
        );
        state = await client.query<ActivityStateRow>(
          `SELECT progress_milli, target_roll, target_milli, cycle_no, last_activity_at, last_player_id, sender_streak
           FROM competitive_spawn_activity_state
           WHERE community_group_id = $1
           FOR UPDATE`,
          [input.communityGroupId],
        );
      }
      const current = state.rows[0];
      if (current === undefined)
        throw new Error("Competitive spawn activity state was not created");

      const decay = competitiveActivityDecayedProgressMilli(
        current.progress_milli,
        current.last_activity_at,
        input.now,
      );
      const targetRoll = decay.resetCycle
        ? competitiveActivityIdleAssistRoll(input.targetRoll)
        : current.target_roll === null
          ? input.targetRoll
          : current.target_roll;
      const cycleNo = BigInt(current.cycle_no) + (decay.resetCycle ? 1n : 0n);

      const sender = await client.query<ActivitySenderRow>(
        `SELECT last_message_at, last_fingerprint, last_fingerprint_at
         FROM competitive_spawn_activity_senders
         WHERE community_group_id = $1 AND player_id = $2
         FOR UPDATE`,
        [input.communityGroupId, input.playerId],
      );
      const previousSender = sender.rows[0];
      const sinceSameSenderMs =
        previousSender === undefined
          ? null
          : Math.max(0, input.now.getTime() - previousSender.last_message_at.getTime());
      const repeatedRecently =
        previousSender?.last_fingerprint === input.fingerprint &&
        previousSender.last_fingerprint_at !== null &&
        input.now.getTime() - previousSender.last_fingerprint_at.getTime() <=
          COMPETITIVE_ACTIVITY_REPEAT_WINDOW_MS;

      await client.query(
        `INSERT INTO competitive_spawn_activity_senders(
           community_group_id, player_id, sender_ref, last_message_at,
           last_fingerprint, last_fingerprint_at, active_at
         ) VALUES ($1, $2, $3, $4, $5, $4, $4)
         ON CONFLICT (community_group_id, player_id) DO UPDATE SET
           sender_ref = EXCLUDED.sender_ref,
           last_message_at = EXCLUDED.last_message_at,
           last_fingerprint = EXCLUDED.last_fingerprint,
           last_fingerprint_at = EXCLUDED.last_fingerprint_at,
           active_at = EXCLUDED.active_at`,
        [input.communityGroupId, input.playerId, input.senderRef, input.now, input.fingerprint],
      );

      const participants = await activeParticipants(client, input.communityGroupId, input.now);
      const monotoneTargetMilli = competitiveActivityMonotoneTargetMilli({
        previousTargetMilli:
          decay.resetCycle || current.target_roll === null ? null : current.target_milli,
        activeParticipants: participants,
        roll: targetRoll,
        resetCycle: decay.resetCycle,
      });
      const targetMilli =
        input.incenseActive === true
          ? Math.min(monotoneTargetMilli, competitiveIncenseTargetMilli(targetRoll))
          : monotoneTargetMilli;
      const nextStreak = current.last_player_id === input.playerId ? current.sender_streak + 1 : 1;
      const creditedMilli = competitiveActivityCreditMilli({
        baseWeightMilli: input.baseWeightMilli,
        activeParticipants: participants,
        sinceSameSenderMs,
        repeatedRecently,
        senderStreak: nextStreak,
      });
      const progressMilli = Math.max(0, decay.progressMilli + creditedMilli);

      await client.query(
        `UPDATE competitive_spawn_activity_state
         SET progress_milli = $2,
             target_roll = $3,
             target_milli = $4,
             cycle_no = $5,
             last_activity_at = $6,
             last_player_id = $7,
             sender_streak = $8,
             updated_at = $6
         WHERE community_group_id = $1`,
        [
          input.communityGroupId,
          progressMilli,
          targetRoll,
          targetMilli,
          cycleNo.toString(),
          input.now,
          input.playerId,
          nextStreak,
        ],
      );

      await client.query(
        `INSERT INTO competitive_spawn_activity_receipts(
           provider, external_message_id, community_group_id, player_id,
           sender_ref, credited_milli, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.provider,
          input.externalMessageId,
          input.communityGroupId,
          input.playerId,
          input.senderRef,
          creditedMilli,
          input.now,
        ],
      );

      return observation({
        progressMilli,
        targetRoll,
        targetMilli,
        activeParticipants: participants,
        creditedMilli,
        frozen: null,
      });
    });
  }
}
