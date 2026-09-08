import type { RandomSource } from "../../platform/rng/index.js";
import type { EncounterView } from "../encounter/contracts.js";
import type { EncounterService } from "../encounter/service.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export type FishingRarity = "COMMON" | "UNCOMMON" | "RARE" | "EXTREMELY_RARE";

export interface FishingAttemptInput {
  readonly playerId: PlayerId;
  readonly idempotencyKey: string;
}

export interface ReserveFishingAttemptInput extends FishingAttemptInput {
  readonly roll: number;
}

export interface FishingAttemptReserved {
  readonly kind: "RESERVED";
  readonly attemptId: string;
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly fishingPointName: string;
  readonly attemptNo: number;
  readonly dailyLimit: number;
  readonly remainingAttempts: number;
  readonly roll: number;
  readonly rarity: FishingRarity | null;
  readonly encounterTableSlug: string | null;
  readonly replayed: boolean;
}

export interface FishingDailyLimitReached {
  readonly kind: "DAILY_LIMIT_REACHED";
  readonly playerId: PlayerId;
  readonly dailyLimit: number;
  readonly remainingAttempts: 0;
}

export interface FishingUnavailable {
  readonly kind: "FISHING_UNAVAILABLE";
  readonly playerId: PlayerId;
  readonly reason: string;
}

export type FishingAttemptReservationResult =
  | FishingAttemptReserved
  | FishingDailyLimitReached
  | FishingUnavailable;

export interface FishingAttemptRepository {
  reserveAttempt(input: ReserveFishingAttemptInput): Promise<FishingAttemptReservationResult>;
}

export interface FishingAttemptResult {
  readonly attemptId: string;
  readonly playerId: PlayerId;
  readonly areaId: string;
  readonly fishingPointName: string;
  readonly attemptNo: number;
  readonly dailyLimit: number;
  readonly remainingAttempts: number;
  readonly roll: number;
  readonly rarity: FishingRarity | null;
  readonly replayed: boolean;
  readonly encounter: EncounterView | null;
}

type EncounterCreator = Pick<EncounterService, "createOrReplay">;

export function fishingRarityForRoll(roll: number): FishingRarity | null {
  if (!Number.isSafeInteger(roll) || roll < 1 || roll > 20) {
    throw new RangeError("Fishing D20 roll must be an integer from 1 to 20");
  }
  if (roll <= 9) return null;
  if (roll <= 14) return "COMMON";
  if (roll <= 17) return "UNCOMMON";
  if (roll <= 19) return "RARE";
  return "EXTREMELY_RARE";
}

export class FishingService {
  public constructor(
    private readonly repository: FishingAttemptRepository,
    private readonly encounters: EncounterCreator,
    private readonly random: RandomSource,
  ) {}

  public async attempt(input: FishingAttemptInput): Promise<Result<FishingAttemptResult>> {
    const generatedRoll = this.random.randomInt(20) + 1;
    const reservation = await this.repository.reserveAttempt({ ...input, roll: generatedRoll });
    if (reservation.kind === "DAILY_LIMIT_REACHED") {
      return err(
        appError("ACTION_INVALID", "Daily fishing attempt limit reached", {
          dailyLimit: reservation.dailyLimit,
          remainingAttempts: reservation.remainingAttempts,
        }),
      );
    }
    if (reservation.kind === "FISHING_UNAVAILABLE") {
      return err(
        appError("ACTION_INVALID", "Fishing is unavailable here", {
          reason: reservation.reason,
        }),
      );
    }

    const rarity = fishingRarityForRoll(reservation.roll);
    if (rarity !== reservation.rarity) {
      return err(
        appError("INVALID_STATE_TRANSITION", "Fishing reservation rarity is inconsistent"),
      );
    }

    let encounter: EncounterView | null = null;
    if (rarity !== null) {
      const encounterTableSlug = reservation.encounterTableSlug?.trim() ?? "";
      if (encounterTableSlug.length === 0) {
        if (rarity === "COMMON" || rarity === "UNCOMMON") {
          return err(
            appError(
              "INVALID_STATE_TRANSITION",
              "Fishing rarity has no configured encounter table",
              {
                rarity,
              },
            ),
          );
        }
      } else {
        const created = await this.encounters.createOrReplay({
          playerId: reservation.playerId,
          idempotencyKey: `fishing:${reservation.attemptId}`,
          encounterTableSlug,
        });
        if (!created.ok) return created;
        encounter = created.value;
      }
    }

    return ok({
      attemptId: reservation.attemptId,
      playerId: reservation.playerId,
      areaId: reservation.areaId,
      fishingPointName: reservation.fishingPointName,
      attemptNo: reservation.attemptNo,
      dailyLimit: reservation.dailyLimit,
      remainingAttempts: reservation.remainingAttempts,
      roll: reservation.roll,
      rarity,
      replayed: reservation.replayed,
      encounter,
    });
  }
}
