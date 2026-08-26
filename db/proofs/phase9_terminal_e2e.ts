import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { BattleAction, BattleState } from "../../src/modules/battle/contracts.js";
import { BattleRuntimeService } from "../../src/modules/battle/runtime.js";
import { BattleService } from "../../src/modules/battle/service.js";
import { PostgresBattleAftermath } from "../../src/platform/battle/postgres-battle-aftermath.js";
import { PostgresBattleCancellation } from "../../src/platform/battle/postgres-battle-cancellation.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { AesBattleSeedReader } from "../../src/platform/rng/battle-seed-reader.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 9 terminal battle E2E proof");
}

const BATTLE_KEY = Buffer.alloc(32, 0xa5);

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

function playerAction(state: BattleState): BattleAction {
  const playerSide = state.sides.find((side) => side.controllerKind === "PLAYER");
  const opponentSide = state.sides.find((side) => side.sideNo !== playerSide?.sideNo);
  if (playerSide === undefined || opponentSide === undefined) {
    throw new Error("Terminal proof requires one player side and one opponent side");
  }
  const actor = state.combatants.find(
    (entry) => entry.participantId === playerSide.activeParticipantId,
  );
  const target = state.combatants.find(
    (entry) => entry.participantId === opponentSide.activeParticipantId,
  );
  if (actor === undefined || target === undefined) throw new Error("Terminal proof combatant missing");
  const move = actor.moves.find((entry) => entry.ppCurrent === null || entry.ppCurrent > 0);
  if (move === undefined) throw new Error("Terminal proof player has no usable move");
  return {
    type: "USE_MOVE",
    actorParticipantId: actor.participantId,
    moveSlot: move.slotNo,
    targetParticipantId: target.participantId,
  };
}

async function cloneActiveBattleForCancellation(
  pool: Pool,
  sourceBattleId: string,
  sourceState: BattleState,
): Promise<string> {
  const rootResult = await pool.query<{
    battle_type: "WILD" | "NPC" | "PVP";
    content_release_id: string;
    ruleset_id: string;
    rng_seed_ciphertext: Buffer;
    rng_seed_iv: Buffer;
    rng_seed_auth_tag: Buffer;
    rng_seed_key_version: number;
    rng_counter: string;
  }>(
    `SELECT battle_type, content_release_id, ruleset_id,
            rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag,
            rng_seed_key_version, rng_counter::text
     FROM battles
     WHERE id = $1`,
    [sourceBattleId],
  );
  const root = rootResult.rows[0];
  if (root === undefined) throw new Error("Source battle root missing for cancellation clone");

  const battleId = randomUUID();
  const participantIds = new Map(sourceState.combatants.map((entry) => [entry.participantId, randomUUID()]));
  const state = structuredClone(sourceState);
  state.battleId = battleId;
  state.encounterId = null;
  state.status = "ACTIVE";
  state.turnNumber = 0;
  state.version = 0;
  state.sides = state.sides.map((side) => ({
    ...side,
    participantIds: side.participantIds.map((id) => participantIds.get(id)!),
    activeParticipantId: participantIds.get(side.activeParticipantId)!,
    result: null,
  }));
  state.combatants = state.combatants.map((combatant) => ({
    ...combatant,
    participantId: participantIds.get(combatant.participantId)!,
  }));

  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id, encounter_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag,
       rng_seed_key_version, rng_counter
     ) VALUES ($1, $2, 'ACTIVE', $3, $4, NULL, 0, 0, $5, $6, $7, $8, $9)`,
    [
      battleId,
      root.battle_type,
      root.content_release_id,
      root.ruleset_id,
      root.rng_seed_ciphertext,
      root.rng_seed_iv,
      root.rng_seed_auth_tag,
      root.rng_seed_key_version,
      root.rng_counter,
    ],
  );

  const sideIds = new Map<number, string>();
  for (const side of state.sides) {
    const sideId = randomUUID();
    sideIds.set(side.sideNo, sideId);
    await pool.query(
      `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id, result)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [sideId, battleId, side.sideNo, side.controllerKind, side.playerId],
    );
  }
  for (const combatant of state.combatants) {
    const sideId = sideIds.get(combatant.sideNo);
    if (sideId === undefined) throw new Error("Cancellation clone side mapping missing");
    await pool.query(
      `INSERT INTO battle_participants(
         id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
         roster_position, active_member, snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7::jsonb)`,
      [
        combatant.participantId,
        battleId,
        sideId,
        combatant.pokemonInstanceId,
        combatant.participantKind,
        combatant.rosterPosition,
        JSON.stringify(combatant),
      ],
    );
  }
  await pool.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 0, 1, $2::jsonb)`,
    [battleId, JSON.stringify(state)],
  );
  return battleId;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  try {
    const identity = await pool.query<{ player_id: string }>(
      `SELECT player_id
       FROM player_identities
       WHERE provider = 'phase9-proof'
         AND external_id = 'battle-e2e'
         AND status = 'ACTIVE'`,
    );
    const playerId = identity.rows[0]?.player_id;
    if (playerId === undefined) {
      throw new Error("Phase 9 terminal proof requires the preceding battle E2E player");
    }

    const activeBattle = await pool.query<{ id: string }>(
      `SELECT battle.id
       FROM battle_sides side
       JOIN battles battle ON battle.id = side.battle_id
       WHERE side.player_id = $1
         AND battle.status = 'ACTIVE'
       ORDER BY battle.created_at DESC
       LIMIT 1`,
      [playerId],
    );
    const battleId = activeBattle.rows[0]?.id;
    if (battleId === undefined) {
      throw new Error("Phase 9 terminal proof requires the preceding ACTIVE battle");
    }

    const seedReader = new AesBattleSeedReader(new Map([[1, BATTLE_KEY]]));
    const core = new BattleService(new PostgresBattleRepository(pool), seedReader);
    const runtime = new BattleRuntimeService(
      core,
      new PostgresBattleAftermath(pool),
      new PostgresBattleCancellation(pool),
    );
    const source = unwrap("load source battle", await runtime.currentState(battleId));

    const cancellationBattleId = await cloneActiveBattleForCancellation(pool, battleId, source);
    const cancelled = unwrap(
      "cancel cloned battle",
      await runtime.cancel({
        battleId: cancellationBattleId,
        expectedVersion: 0,
        reason: "phase9 deterministic operator cancellation proof",
      }),
    );
    if (cancelled.replayed || cancelled.state.status !== "CANCELLED") {
      throw new Error("First cancellation did not persist a CANCELLED terminal snapshot");
    }
    if (!cancelled.state.sides.every((side) => side.result === "CANCELLED")) {
      throw new Error("Cancellation did not mark every side CANCELLED");
    }
    const cancellationReplay = unwrap(
      "replay cloned cancellation",
      await runtime.cancel({
        battleId: cancellationBattleId,
        expectedVersion: 0,
        reason: "phase9 deterministic operator cancellation proof",
      }),
    );
    if (!cancellationReplay.replayed || cancellationReplay.state.version !== cancelled.state.version) {
      throw new Error("Repeated cancellation did not replay the persisted terminal state");
    }
    const cancellationAudit = await pool.query<{
      status: string;
      ended: boolean;
      cancelled_sides: string;
      end_events: string;
    }>(
      `SELECT
         battle.status,
         battle.ended_at IS NOT NULL AS ended,
         (SELECT count(*)::text FROM battle_sides WHERE battle_id = battle.id AND result = 'CANCELLED') AS cancelled_sides,
         (SELECT count(*)::text FROM battle_events WHERE battle_id = battle.id AND event_type = 'BattleEnded' AND payload ->> 'status' = 'CANCELLED') AS end_events
       FROM battles battle
       WHERE battle.id = $1`,
      [cancellationBattleId],
    );
    const cancellationRow = cancellationAudit.rows[0];
    if (
      cancellationRow === undefined ||
      cancellationRow.status !== "CANCELLED" ||
      !cancellationRow.ended ||
      Number(cancellationRow.cancelled_sides) !== cancelled.state.sides.length ||
      cancellationRow.end_events !== "1"
    ) {
      throw new Error(`Cancellation persistence audit failed: ${JSON.stringify(cancellationRow)}`);
    }

    const walletBefore = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(balance), 0)::text AS total
       FROM wallet_balances
       WHERE player_id = $1`,
      [playerId],
    );
    const locationBefore = await pool.query<{ slug: string; revision: string }>(
      `SELECT area.slug, location.revision::text
       FROM player_locations location
       JOIN areas area ON area.id = location.area_id
       WHERE location.player_id = $1`,
      [playerId],
    );
    if (locationBefore.rows[0]?.slug !== "route-1") {
      throw new Error("Defeat proof must start from non-safe Route 1");
    }

    const current = unwrap("reload battle before defeat", await runtime.currentState(battleId));
    const doomed = structuredClone(current);
    const playerSide = doomed.sides.find((side) => side.controllerKind === "PLAYER");
    if (playerSide === undefined) throw new Error("Defeat proof player side missing");
    const actor = doomed.combatants.find(
      (combatant) => combatant.participantId === playerSide.activeParticipantId,
    );
    if (actor === undefined) throw new Error("Defeat proof active player combatant missing");
    actor.currentHp = 1;
    actor.majorStatus = { key: "POISON", counter: null };
    for (const move of actor.moves) move.power = move.power === null ? null : 0;

    const patched = await pool.query(
      `UPDATE battle_state_snapshots
       SET state = $3::jsonb
       WHERE battle_id = $1 AND version = $2`,
      [battleId, current.version, JSON.stringify(doomed)],
    );
    if (patched.rowCount !== 1) throw new Error("Could not prepare deterministic defeat snapshot");

    const action = playerAction(doomed);
    const defeated = unwrap(
      "resolve deterministic defeat",
      await runtime.resolvePlayerTurn({
        battleId,
        playerId,
        expectedVersion: doomed.version,
        idempotencyKey: "phase9-terminal-defeat",
        action,
      }),
    );
    if (defeated.state.status !== "LOST") {
      throw new Error(`Expected LOST terminal state, got ${defeated.state.status}`);
    }

    const walletAfter = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(balance), 0)::text AS total
       FROM wallet_balances
       WHERE player_id = $1`,
      [playerId],
    );
    if (walletAfter.rows[0]?.total !== walletBefore.rows[0]?.total) {
      throw new Error("Defeat policy changed wallet balance despite automaticMoneyLoss=false");
    }
    const locationAfter = await pool.query<{ slug: string; revision: string }>(
      `SELECT area.slug, location.revision::text
       FROM player_locations location
       JOIN areas area ON area.id = location.area_id
       WHERE location.player_id = $1`,
      [playerId],
    );
    const relocated = locationAfter.rows[0];
    if (relocated?.slug !== "pallet-town") {
      throw new Error(`Defeat aftermath did not return player to Pallet Town: ${relocated?.slug}`);
    }

    const defeatReplay = unwrap(
      "replay deterministic defeat",
      await runtime.resolvePlayerTurn({
        battleId,
        playerId,
        expectedVersion: doomed.version,
        idempotencyKey: "phase9-terminal-defeat",
        action,
      }),
    );
    if (!defeatReplay.replayed || defeatReplay.state.status !== "LOST") {
      throw new Error("Defeat retry did not replay the terminal battle snapshot");
    }
    const locationAfterReplay = await pool.query<{ revision: string }>(
      `SELECT revision::text FROM player_locations WHERE player_id = $1`,
      [playerId],
    );
    if (locationAfterReplay.rows[0]?.revision !== relocated.revision) {
      throw new Error("Idempotent defeat replay moved the already-safe player a second time");
    }

    console.log(
      `Phase 9 terminal E2E complete: cancelled ${cancellationBattleId}; defeated ${battleId}; safe point pallet-town; wallet unchanged`,
    );
  } finally {
    await pool.end();
  }
}

await main();
