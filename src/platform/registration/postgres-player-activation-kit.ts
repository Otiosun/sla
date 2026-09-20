import type { Pool } from "pg";
import { EconomyService } from "../../modules/economy/service.js";
import type { PlayerActivationKitPort } from "../../modules/registration/provisioning-service.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { PostgresEconomyRepository } from "../economy/postgres-economy-repository.js";

const INITIAL_POKEDOLLARS = 2_000n;
const INITIAL_POKE_BALLS = 5n;

export interface PlayerActivationKitGrant {
  readonly pokedollars: bigint;
  readonly pokeBalls: bigint;
  readonly walletReplayed: boolean;
  readonly inventoryReplayed: boolean;
}

export class PostgresPlayerActivationKit implements PlayerActivationKitPort {
  private readonly economy: EconomyService;

  public constructor(
    private readonly pool: Pool,
    economy?: EconomyService,
  ) {
    this.economy = economy ?? new EconomyService(new PostgresEconomyRepository(pool));
  }

  public async grant(input: {
    readonly reviewId: string;
    readonly playerId: PlayerId;
  }): Promise<Result<PlayerActivationKitGrant>> {
    const catalog = await this.resolveCatalog();
    if (!catalog.ok) return catalog;

    const metadata = {
      sourceType: "PLAYER.ACTIVATION.KIT",
      sourceId: input.reviewId,
      reason: "Initial trainer activation kit",
      actorType: "SYSTEM" as const,
      actorId: null,
      correlationId: input.reviewId,
    };

    const wallet = await this.economy.creditWallet({
      playerId: input.playerId,
      currencyId: catalog.value.currencyId,
      amount: INITIAL_POKEDOLLARS,
      idempotencyKey: `${input.reviewId}:initial-wallet`,
      metadata,
    });
    if (!wallet.ok) return wallet;

    const inventory = await this.economy.addItem({
      playerId: input.playerId,
      itemId: catalog.value.pokeBallItemId,
      quantity: INITIAL_POKE_BALLS,
      idempotencyKey: `${input.reviewId}:initial-poke-balls`,
      metadata,
    });
    if (!inventory.ok) return inventory;

    return ok({
      pokedollars: INITIAL_POKEDOLLARS,
      pokeBalls: INITIAL_POKE_BALLS,
      walletReplayed: wallet.value.replayed,
      inventoryReplayed: inventory.value.replayed,
    });
  }

  private async resolveCatalog(): Promise<
    Result<{ readonly currencyId: string; readonly pokeBallItemId: string }>
  > {
    const result = await this.pool.query<{
      currency_id: string | null;
      poke_ball_item_id: string | null;
    }>(
      `SELECT
         (SELECT id FROM currency_definitions WHERE slug='pokedollar' LIMIT 1) AS currency_id,
         (
           SELECT item.id
           FROM content_release_pointers pointer
           JOIN item_revisions revision
             ON revision.content_release_id=pointer.content_release_id
            AND revision.active=TRUE
           JOIN items item ON item.id=revision.item_id
           WHERE pointer.pointer_key='ACTIVE'
             AND item.slug='poke-ball'
           LIMIT 1
         ) AS poke_ball_item_id`,
    );
    const row = result.rows[0];
    if (row?.currency_id === null || row?.currency_id === undefined) {
      return err(appError("FEATURE_UNAVAILABLE", "PokéDollar is unavailable for the initial kit"));
    }
    if (row.poke_ball_item_id === null || row.poke_ball_item_id === undefined) {
      return err(appError("FEATURE_UNAVAILABLE", "Poké Ball is unavailable for the initial kit"));
    }
    return ok({
      currencyId: row.currency_id,
      pokeBallItemId: row.poke_ball_item_id,
    });
  }
}
