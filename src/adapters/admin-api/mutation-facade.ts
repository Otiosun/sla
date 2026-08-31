import { z } from "zod";
import {
  AdminMutationRequestSchema,
  type AdminPreparedOperation,
} from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";

const AdminMutationTrustedContextSchema = z
  .object({
    principalId: z.string().uuid(),
    environment: z.enum(["development", "staging", "production"]),
    correlationId: z.string().uuid(),
  })
  .strict();

const AdminMutationClientRequestSchema = AdminMutationRequestSchema.omit({
  principalId: true,
  correlationId: true,
});

export interface AdminMutationPreparationEndpoint {
  prepareMutation(rawRequest: unknown): Promise<AdminPreparedOperation>;
}

/**
 * Trusted boundary between an authenticated Admin API request and the existing
 * anti-abuse/AdminService mutation pipeline.
 *
 * Browser-controlled data can describe the requested operation, but can never
 * select the acting principal, environment or correlation id. Those values
 * belong to server-owned request context.
 *
 * This facade intentionally exposes only mutation preparation. Lifecycle
 * actions (simulate/confirm/approve/apply) remain outside the HTTP adapter until
 * their transport contracts and security gates are explicitly proven.
 */
export class AdminMutationFacade {
  public constructor(private readonly endpoint: AdminMutationPreparationEndpoint) {}

  public async prepareMutation(
    rawContext: unknown,
    rawClientRequest: unknown,
  ): Promise<AdminPreparedOperation> {
    const context = AdminMutationTrustedContextSchema.safeParse(rawContext);
    if (!context.success) {
      throw new AdminError(
        ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
        "Invalid administrative request context",
      );
    }

    const clientRequest = AdminMutationClientRequestSchema.safeParse(rawClientRequest);
    if (!clientRequest.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid administrative mutation");
    }

    const input =
      clientRequest.data.operationType === "admin.session.revoke_all"
        ? { ...clientRequest.data.input, environment: context.data.environment }
        : clientRequest.data.input;

    return this.endpoint.prepareMutation({
      ...clientRequest.data,
      input,
      principalId: context.data.principalId,
      correlationId: context.data.correlationId,
    });
  }
}
