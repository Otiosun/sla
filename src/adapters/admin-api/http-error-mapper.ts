import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import { AdminUnauthenticatedError } from "./request-authenticator.js";

export interface AdminHttpErrorResponse {
  readonly statusCode: number;
  readonly body: {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly correlationId: string;
    };
  };
}

function response(
  statusCode: number,
  code: string,
  message: string,
  correlationId: string,
): AdminHttpErrorResponse {
  return {
    statusCode,
    body: { error: { code, message, correlationId } },
  };
}

export function mapAdminHttpError(error: unknown, correlationId: string): AdminHttpErrorResponse {
  if (error instanceof AdminUnauthenticatedError) {
    return response(
      401,
      "ADMIN_UNAUTHENTICATED",
      "Administrative authentication required",
      correlationId,
    );
  }
  if (!(error instanceof AdminError)) {
    return response(500, "ADMIN_INTERNAL_ERROR", "Administrative request failed", correlationId);
  }

  switch (error.code) {
    case ADMIN_ERROR_CODES.AUTHORIZATION_DENIED:
    case ADMIN_ERROR_CODES.PRINCIPAL_DISABLED:
    case ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND:
      return response(
        403,
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Administrative access denied",
        correlationId,
      );
    case ADMIN_ERROR_CODES.INVALID_INPUT:
    case ADMIN_ERROR_CODES.REASON_REQUIRED:
    case ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED:
      return response(400, error.code, "Invalid administrative request", correlationId);
    case ADMIN_ERROR_CODES.TARGET_NOT_FOUND:
    case ADMIN_ERROR_CODES.OPERATION_NOT_FOUND:
      return response(404, error.code, "Administrative target not found", correlationId);
    case ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT:
    case ADMIN_ERROR_CODES.REVISION_CONFLICT:
    case ADMIN_ERROR_CODES.INVALID_OPERATION_STATE:
    case ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED:
    case ADMIN_ERROR_CODES.SELF_APPROVAL_FORBIDDEN:
      return response(409, error.code, "Administrative request conflict", correlationId);
    case ADMIN_ERROR_CODES.OPERATION_NOT_REGISTERED:
    case ADMIN_ERROR_CODES.OPERATION_KIND_MISMATCH:
    case ADMIN_ERROR_CODES.CAPABILITY_POLICY_DRIFT:
    case ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT:
      return response(500, "ADMIN_INTERNAL_ERROR", "Administrative request failed", correlationId);
  }

  return response(500, "ADMIN_INTERNAL_ERROR", "Administrative request failed", correlationId);
}
