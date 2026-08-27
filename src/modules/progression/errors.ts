export type ProgressionErrorCode =
  | "PROGRESSION_INPUT_INVALID"
  | "BATTLE_NOT_FOUND"
  | "BATTLE_REWARD_NOT_ELIGIBLE"
  | "BATTLE_REWARD_UNSUPPORTED"
  | "PROGRESSION_RULES_MISSING"
  | "PROGRESSION_STATE_INVALID"
  | "PROGRESSION_IDEMPOTENCY_CONFLICT"
  | "TRAINER_PROGRESSION_NOT_FOUND"
  | "TRAINER_PROGRESSION_UNDERFLOW"
  | "MOVE_CHOICE_NOT_FOUND"
  | "MOVE_CHOICE_CONFLICT"
  | "EVOLUTION_NOT_FOUND"
  | "EVOLUTION_NOT_ELIGIBLE"
  | "EVOLUTION_ITEM_MISSING";

export interface ProgressionError {
  readonly code: ProgressionErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ProgressionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProgressionError };

export function progressionFailure(
  code: ProgressionErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ProgressionResult<never> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}
