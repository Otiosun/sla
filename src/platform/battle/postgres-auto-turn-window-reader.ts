import type { Pool } from "pg";
import type {
  AutoTurnBatchInput,
  AutoTurnWindowReader,
} from "../../modules/battle/auto-turn-dispatcher.js";

export class PostgresAutoTurnWindowReader implements AutoTurnWindowReader {
  public constructor(
    private readonly pool: Pool,
    private readonly permitsBattle?: (battleId: string) => Promise<boolean>,
  ) {}

  public async listLockedAutoWindows(input: AutoTurnBatchInput): Promise<readonly string[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error("AUTO turn batch limit must be a positive safe integer");
    }
    const allowed: string[] = [];
    for (let offset = 0; allowed.length < input.limit; offset += input.limit) {
      const result = await this.pool.query<{ id: string; battle_id: string }>(
        `SELECT w.id, w.battle_id FROM battle_turn_windows w
       JOIN battles b ON b.id = w.battle_id
         AND b.version = w.battle_version AND b.turn_number = w.turn_number
       WHERE b.status = 'ACTIVE' AND w.status = 'LOCKED'
         AND w.required_controllers = '[]'::jsonb
         AND ($2::uuid IS NULL OR b.id = $2)
       ORDER BY w.locked_at, w.id LIMIT $1 OFFSET $3`,
        [input.limit, input.battleId ?? null, offset],
      );
      for (const row of result.rows) {
        if (!this.permitsBattle || (await this.permitsBattle(row.battle_id))) allowed.push(row.id);
        if (allowed.length === input.limit) break;
      }
      if (!this.permitsBattle || result.rows.length < input.limit) break;
    }
    return allowed;
  }
}
