import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import { normalizeAdminPlayerWhatsAppExternalId } from "./player-search-query.js";
import {
  AdminPlayerWhatsAppChangeRequestSchema,
  adminPlayerIdentityDigest,
  externalIdentityLast4,
} from "./player-identity-contracts.js";
import type { AdminPlayerIdentityChangeOwner } from "./player-identity-ports.js";
import type { AdminService } from "./service.js";

export class AdminPlayerIdentityService {
  public constructor(
    private readonly admin: Pick<AdminService, "prepareEphemeralSensitiveMutation">,
    private readonly owner: AdminPlayerIdentityChangeOwner,
  ) {}

  public async changeWhatsApp(rawRequest: unknown) {
    const parsed = AdminPlayerWhatsAppChangeRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_INPUT,
        "Invalid WhatsApp identity change request",
      );
    }

    const request = parsed.data;
    const externalId = normalizeAdminPlayerWhatsAppExternalId(request.newWhatsApp);
    if (externalId === null) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid WhatsApp phone number");
    }

    const sanitizedInput = {
      playerId: request.playerId,
      newIdentityDigest: adminPlayerIdentityDigest(request.playerId, externalId),
      newIdentityLast4: externalIdentityLast4(externalId),
    };
    const prepared = await this.admin.prepareEphemeralSensitiveMutation({
      principalId: request.principalId,
      operationType: "player.identity.whatsapp.change",
      input: sanitizedInput,
      reason: request.reason,
      expectedRevision: request.expectedRevision,
      idempotencyKey: `hub-player-identity:${request.requestId}`,
      correlationId: request.requestId,
    });

    if (prepared.operation.status === "APPLIED") {
      return { operation: prepared.operation, replayed: true };
    }
    if (prepared.operation.status !== "READY") {
      throw new AdminError(
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
        `WhatsApp identity change is not ready from ${prepared.operation.status}`,
      );
    }

    const operation = await this.owner.changeWhatsAppIdentity({
      operation: prepared.operation,
      actorPrincipalId: request.principalId,
      externalId,
    });
    return { operation, replayed: prepared.replayed };
  }
}
