import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { withTransaction } from "../../platform/db/transaction.js";

export type MoveTrainingMethod = "REMINDER" | "TM";

export interface MoveTrainingOption {
  readonly moveId: string;
  readonly displayName: string;
  readonly method: MoveTrainingMethod;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly itemQuantity: bigint | null;
}

export interface MoveTrainingInput {
  readonly playerId: PlayerId;
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly method: MoveTrainingMethod;
  readonly moveId: string;
  readonly itemId: string | null;
  /** Null auto-fills the first free slot; with four slots occupied the player chooses 1–4. */
  readonly replaceSlotNo: number | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface MoveTrainingResult {
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly moveId: string;
  readonly slotNo: number;
  readonly replacedMoveId: string | null;
  readonly itemId: string | null;
  readonly replayed: boolean;
}

type PokemonRow = {
  form_id: string;
  level: number;
  content_release_id: string;
};

type OptionRow = {
  move_id: string;
  display_name: string;
  item_id: string | null;
  item_name: string | null;
  item_quantity: string | null;
};

/**
 * Actual move acquisition for the trainer-pinned catalog.
 * REMINDER: free, only an already earned/eligible move. TM: compatible machine
 * and one owned item. Both use one locked transaction, history claim and full PP.
 */
export class MoveTrainingService {
  public constructor(private readonly pool: Pool) {}

  private async eligible(
    client: PoolClient,
    playerId: PlayerId,
    pokemonInstanceId: PokemonInstanceId,
    method: MoveTrainingMethod,
  ): Promise<{ pokemon: PokemonRow | null; options: readonly MoveTrainingOption[] }> {
    const pokemonResult = await client.query<PokemonRow>(
      `SELECT pokemon.form_id, pokemon.level, context.content_release_id
       FROM pokemon_instances pokemon
       JOIN player_onboarding_context context ON context.player_id = pokemon.owner_player_id
       WHERE pokemon.id = $1 AND pokemon.owner_player_id = $2 AND pokemon.status = 'ACTIVE'`,
      [pokemonInstanceId, playerId],
    );
    const pokemon = pokemonResult.rows[0] ?? null;
    if (pokemon === null) return { pokemon: null, options: [] };

    const optionsResult = method === "REMINDER"
      ? await client.query<OptionRow>(
          `WITH permitted AS (
             SELECT entry.move_id FROM move_learnset_entries entry
             WHERE entry.content_release_id = $2 AND entry.form_id = $3
               AND entry.active = TRUE
               AND (entry.learn_method = 'START'
                  OR (entry.learn_method = 'LEVEL' AND entry.learn_level <= $4))
             UNION
             SELECT choice.move_id FROM pending_move_choices choice
             WHERE choice.pokemon_instance_id = $1 AND choice.content_release_id = $2
               AND choice.learn_level <= $4
             UNION
             SELECT (event.payload->>'moveId')::uuid
             FROM pokemon_history_events event
             WHERE event.pokemon_instance_id = $1
               AND event.event_type IN ('MOVE_LEARNED', 'MOVE_REPLACED', 'MOVE_TRAINED')
               AND event.payload ? 'moveId'
           )
           SELECT revision.move_id, revision.display_name,
                  NULL::text AS item_id, NULL::text AS item_name,
                  NULL::text AS item_quantity
           FROM permitted
           JOIN move_revisions revision ON revision.move_id = permitted.move_id
             AND revision.content_release_id = $2 AND revision.active = TRUE
           WHERE NOT EXISTS (
             SELECT 1 FROM pokemon_move_slots slot
             WHERE slot.pokemon_instance_id = $1 AND slot.move_id = revision.move_id
           )
           ORDER BY revision.display_name, revision.move_id`,
          [pokemonInstanceId, pokemon.content_release_id, pokemon.form_id, pokemon.level],
        )
      : await client.query<OptionRow>(
          `SELECT DISTINCT ON (revision.move_id, item.item_id)
                    revision.move_id, revision.display_name,
                    item.item_id::text, item.display_name AS item_name,
                    balance.quantity::text AS item_quantity
           FROM move_learnset_entries entry
           JOIN move_revisions revision ON revision.move_id = entry.move_id
             AND revision.content_release_id = entry.content_release_id
             AND revision.active = TRUE
           JOIN item_revisions item ON item.content_release_id = entry.content_release_id
             AND item.active = TRUE AND item.item_kind = 'TM'
             AND item.effect_key = 'teach-move'
             AND item.effect_config->>'moveId' = entry.move_id::text
           JOIN inventory_balances balance ON balance.player_id = $5
             AND balance.item_id = item.item_id AND balance.quantity > 0
           WHERE entry.content_release_id = $2 AND entry.form_id = $3
             AND entry.learn_method IN ('MACHINE', 'TM')
             AND entry.active = TRUE
             AND NOT EXISTS (
               SELECT 1 FROM pokemon_move_slots slot
               WHERE slot.pokemon_instance_id = $1 AND slot.move_id = entry.move_id
             )
           ORDER BY revision.move_id, item.item_id`,
          [pokemonInstanceId, pokemon.content_release_id, pokemon.form_id, pokemon.level, playerId],
        );
    return {
      pokemon,
      options: optionsResult.rows.map((row) => ({
        moveId: row.move_id,
        displayName: row.display_name,
        method,
        itemId: row.item_id,
        itemName: row.item_name,
        itemQuantity: row.item_quantity === null ? null : BigInt(row.item_quantity),
      })).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  public async options(input: {
    playerId: PlayerId;
    pokemonInstanceId: PokemonInstanceId;
    method: MoveTrainingMethod;
  }): Promise<Result<readonly MoveTrainingOption[]>> {
    const client = await this.pool.connect();
    try {
      const data = await this.eligible(client, input.playerId, input.pokemonInstanceId, input.method);
      return data.pokemon === null
        ? err(appError("NOT_FOUND", "Pokémon não encontrado na conta."))
        : ok(data.options);
    } finally {
      client.release();
    }
  }

  public async learn(input: MoveTrainingInput): Promise<Result<MoveTrainingResult>> {
    if (!/^[0-9a-f-]{36}$/iu.test(input.moveId) ||
        input.idempotencyKey.trim().length === 0 ||
        (input.replaceSlotNo !== null &&
         (!Number.isInteger(input.replaceSlotNo) || input.replaceSlotNo < 1 || input.replaceSlotNo > 4))) {
      return err(appError("VALIDATION_FAILED", "Golpe, chave ou posição inválidos."));
    }
    if (input.method === "TM" && (input.itemId === null || !/^[0-9a-f-]{36}$/iu.test(input.itemId))) {
      return err(appError("VALIDATION_FAILED", "Máquina inválida."));
    }
    if (input.method === "REMINDER" && input.itemId !== null) {
      return err(appError("VALIDATION_FAILED", "Reaprendizado não consome TM."));
    }
    const requestKey = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      pokemonId: input.pokemonInstanceId,
      playerId: input.playerId,
      moveId: input.moveId,
      method: input.method,
      itemId: input.itemId,
      slot: input.replaceSlotNo,
    })).digest("hex");

    return withTransaction(this.pool, async (client): Promise<Result<MoveTrainingResult>> => {
      // A single message/request key is globally idempotent across all Pokémon.
      // Serialize the key BEFORE locking an owned Pokémon to avoid lock cycles.
      const signedLock = BigInt.asIntN(64, BigInt("0x" + requestKey.slice(0, 16)));
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [signedLock.toString()]);
      const existing = await client.query<{
        payload: { fingerprint: string; result: MoveTrainingResult };
      }>(
        `SELECT payload FROM pokemon_history_events
         WHERE event_type = 'MOVE_TRAINED'
           AND payload->>'requestKey' = $1 LIMIT 1`,
        [requestKey],
      );
      const replay = existing.rows[0]?.payload;
      if (replay !== undefined) {
        if (replay.fingerprint !== fingerprint) {
          return err(appError("FINGERPRINT_MISMATCH", "A mensagem já foi usada para outra operação."));
        }
        return ok({ ...replay.result, replayed: true });
      }

      // Lock the owned Pokémon after replay checks; distinct requests
      // targeting the same creature serialize before viewing slots/items.
      const locked = await client.query(
        `SELECT id FROM pokemon_instances
         WHERE id = $1 AND owner_player_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
        [input.pokemonInstanceId, input.playerId],
      );
      if (locked.rows.length === 0) return err(appError("NOT_FOUND", "Pokémon não pertence a você."));

      const battle = await client.query(
        `SELECT battle.id FROM battles battle
         LEFT JOIN battle_sides side ON side.battle_id = battle.id
         LEFT JOIN battle_participant_controllers controller ON controller.battle_id = battle.id
         WHERE battle.status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN')
           AND (side.player_id = $1 OR controller.player_id = $1)
         LIMIT 1`,
        [input.playerId],
      );
      if (battle.rows.length > 0) {
        return err(appError("FLOW_BLOCKED", "Termine a batalha antes de alterar golpes."));
      }
      const eligible = await this.eligible(client, input.playerId, input.pokemonInstanceId, input.method);
      if (eligible.pokemon === null) return err(appError("NOT_FOUND", "Pokémon não encontrado."));
      const chosen = eligible.options.find((choice) =>
        choice.moveId === input.moveId && choice.itemId === input.itemId);
      if (chosen === undefined) {
        return err(appError("ACTION_INVALID",
          input.method === "TM" ? "TM indisponível ou incompatível com este Pokémon."
            : "Movimento não elegível para reaprendizado nesta versão."));
      }
      const slots = await client.query<{ slot_no: number; move_id: string }>(
        `SELECT slot_no, move_id FROM pokemon_move_slots
         WHERE pokemon_instance_id = $1 ORDER BY slot_no FOR UPDATE`,
        [input.pokemonInstanceId],
      );
      if (slots.rows.some((slot) => slot.move_id === input.moveId)) {
        return err(appError("ACTION_INVALID", "Este Pokémon já conhece esse golpe."));
      }
      const filled = new Set(slots.rows.map((slot) => slot.slot_no));
      const free = [1, 2, 3, 4].find((no) => !filled.has(no)) ?? null;
      const target = input.replaceSlotNo ?? free;
      if (target === null) {
        return err(appError("ACTION_INVALID",
          "Este Pokémon já tem quatro golpes. Escolha uma posição de 1 a 4 para substituir."));
      }
      const replaced = slots.rows.find((slot) => slot.slot_no === target);
      if (input.replaceSlotNo !== null && replaced === undefined) {
        return err(appError("VALIDATION_FAILED",
          "Essa posição está livre: omita o número do slot para aprender automaticamente."));
      }
      const revision = await client.query<{ max_pp: number | null }>(
        `SELECT max_pp FROM move_revisions
         WHERE content_release_id = $1 AND move_id = $2 AND active = TRUE`,
        [eligible.pokemon.content_release_id, input.moveId],
      );
      const maxPp = revision.rows[0]?.max_pp;
      if (maxPp === undefined) return err(appError("ACTION_INVALID", "Movimento indisponível no catálogo."));

      if (input.method === "TM") {
        const spent = await client.query(
          `UPDATE inventory_balances
           SET quantity = quantity - 1, revision = revision + 1, updated_at = now()
           WHERE player_id = $1 AND item_id = $2 AND quantity >= 1`,
          [input.playerId, input.itemId],
        );
        if (spent.rowCount !== 1) return err(appError("ACTION_INVALID", "TM esgotada na mochila."));
        const ledger = await client.query(
          `INSERT INTO inventory_ledger(
             id, player_id, item_id, delta, source_type, source_id, reason,
             actor_type, actor_id, idempotency_scope, idempotency_key, correlation_id
           ) VALUES ($1, $2, $3, -1, 'MOVE_TRAINING', $4, 'TM move teaching',
                     'PLAYER', $2, 'progression.move-training.item', $5, $6)
           ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`,
          [randomUUID(), input.playerId, input.itemId, requestKey, requestKey, input.correlationId],
        );
        if (ledger.rowCount !== 1) throw new Error("TM consumption ledger conflict");
      }
      if (replaced === undefined) {
        await client.query(
          `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
           VALUES ($1, $2, $3, $4)`,
          [input.pokemonInstanceId, target, input.moveId, maxPp],
        );
      } else {
        await client.query(
          `UPDATE pokemon_move_slots SET move_id = $3, pp_current = $4, learned_at = now()
           WHERE pokemon_instance_id = $1 AND slot_no = $2`,
          [input.pokemonInstanceId, target, input.moveId, maxPp],
        );
      }
      await client.query(
        `UPDATE pokemon_instances SET revision = revision + 1, updated_at = now()
         WHERE id = $1 AND owner_player_id = $2`,
        [input.pokemonInstanceId, input.playerId],
      );
      const result: MoveTrainingResult = {
        pokemonInstanceId: input.pokemonInstanceId,
        moveId: input.moveId,
        slotNo: target,
        replacedMoveId: replaced?.move_id ?? null,
        itemId: input.method === "TM" ? input.itemId : null,
        replayed: false,
      };
      await client.query(
        `INSERT INTO pokemon_history_events(
           id, pokemon_instance_id, event_type, payload, actor_type, actor_id, correlation_id
         ) VALUES ($1, $2, 'MOVE_TRAINED', $3::jsonb, 'PLAYER', $4, $5)`,
        [randomUUID(), input.pokemonInstanceId, JSON.stringify({
          requestKey, fingerprint, moveId: input.moveId, method: input.method, result,
        }), input.playerId, input.correlationId],
      );
      return ok(result);
    });
  }
}
