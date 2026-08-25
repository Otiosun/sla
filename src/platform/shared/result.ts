export interface AppError<Code extends string = string, Details = unknown> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Details | null;
}

export type Result<T, ErrorType extends AppError = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorType };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<ErrorType extends AppError>(error: ErrorType): Result<never, ErrorType> {
  return { ok: false, error };
}

export function appError<Code extends string, Details = unknown>(input: {
  readonly code: Code;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Details;
}): AppError<Code, Details> {
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    details: input.details ?? null,
  };
}

export function mapResult<T, U, ErrorType extends AppError>(
  result: Result<T, ErrorType>,
  mapper: (value: T) => U,
): Result<U, ErrorType> {
  return result.ok ? ok(mapper(result.value)) : result;
}
