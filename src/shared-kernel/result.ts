export const ERROR_CODES = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_ID: "INVALID_ID",
  IDEMPOTENCY_KEY_INVALID: "IDEMPOTENCY_KEY_INVALID",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  FEATURE_UNAVAILABLE: "FEATURE_UNAVAILABLE",
  PLAYER_INELIGIBLE: "PLAYER_INELIGIBLE",
  FLOW_BLOCKED: "FLOW_BLOCKED",
  ACTION_INVALID: "ACTION_INVALID",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function appError(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return details === undefined ? { code, message } : { code, message, details };
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
