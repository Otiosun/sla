import {
  ActivateEvolutionConditionInputSchema,
  type EvolutionConditionState,
  RevokeEvolutionConditionInputSchema,
} from "./evolution-condition-contracts.js";
import type { EvolutionConditionRepository } from "./evolution-condition-ports.js";

export type EvolutionConditionErrorCode =
  | "EVOLUTION_CONDITION_INPUT_INVALID"
  | "EVOLUTION_CONDITION_POKEMON_NOT_FOUND"
  | "EVOLUTION_CONDITION_NOT_FOUND"
  | "EVOLUTION_CONDITION_SOURCE_CONFLICT"
  | "EVOLUTION_CONDITION_STALE_REVISION";

export type EvolutionConditionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: EvolutionConditionErrorCode;
        readonly message: string;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };

export class EvolutionConditionService {
  public constructor(private readonly repository: EvolutionConditionRepository) {}

  public async activate(
    input: unknown,
  ): Promise<EvolutionConditionResult<EvolutionConditionState>> {
    const parsed = ActivateEvolutionConditionInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "EVOLUTION_CONDITION_INPUT_INVALID",
          message: "Invalid evolution condition activation request",
        },
      };
    }
    return this.mapPersistence(await this.repository.activate(parsed.data));
  }

  public async revoke(input: unknown): Promise<EvolutionConditionResult<EvolutionConditionState>> {
    const parsed = RevokeEvolutionConditionInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "EVOLUTION_CONDITION_INPUT_INVALID",
          message: "Invalid evolution condition revocation request",
        },
      };
    }
    return this.mapPersistence(await this.repository.revoke(parsed.data));
  }

  private mapPersistence(
    persisted: Awaited<ReturnType<EvolutionConditionRepository["activate"]>>,
  ): EvolutionConditionResult<EvolutionConditionState> {
    switch (persisted.kind) {
      case "APPLIED":
      case "REPLAYED":
        return { ok: true, value: persisted.state };
      case "POKEMON_NOT_FOUND":
        return {
          ok: false,
          error: {
            code: "EVOLUTION_CONDITION_POKEMON_NOT_FOUND",
            message: "Pokemon was not found",
          },
        };
      case "CONDITION_NOT_FOUND":
        return {
          ok: false,
          error: {
            code: "EVOLUTION_CONDITION_NOT_FOUND",
            message: "Evolution condition state was not found",
          },
        };
      case "SOURCE_CONFLICT":
        return {
          ok: false,
          error: {
            code: "EVOLUTION_CONDITION_SOURCE_CONFLICT",
            message: "Evolution condition is owned by another server source",
          },
        };
      case "STALE_REVISION":
        return {
          ok: false,
          error: {
            code: "EVOLUTION_CONDITION_STALE_REVISION",
            message: "Evolution condition revision is stale",
            details: { currentRevision: persisted.currentRevision },
          },
        };
    }
  }
}
