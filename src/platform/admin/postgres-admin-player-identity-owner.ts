import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AdminOperationRecord } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import {
  AdminPlayerWhatsAppChangeInputSchema,
  adminPlayerIdentityDigest,
  externalIdentityLast4,
} from "../../modules/admin/player-identity-contracts.js";
import type { AdminPlayerIdentityChangeOwner } from "../../modules/admin/player-identity-ports.js";
import { withTransaction } from "../db/transaction.js";
import { completeAppliedAdminOperationWithClient } from "./postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "./postgres-admin-repository.js";

interface IdentityRow {
  id: string;
  player_id: string;
  external_id: string;
  status: "ACTIVE" | "REVOKED";
}

export class PostgresAdminPlayerIdentityOwner implements AdminPlayerIdentityChangeOwner {
  private readonly adminRepository: PostgresAdminRepository;

  public constructor(private readonly pool: Pool) {
    this.adminRepository = new PostgresAdminRepository(pool);
  }

  public async changeWhatsAppIdentity(input: {
    readonly operation: AdminOperationRecord;
    readonly actorPrincipalId: string;
    readonly externalId: string;
  }): Promise<AdminOperationRecord> {
    const operationInput = AdminPlayerWhatsAppChangeInputSchema.safeParse(input.operation.input);
    if (!operationInput.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid persisted identity operation input");
    }
    if (
      input.operation.operationType !== "player.identity.whatsapp.change" ||
      input.operation.targetType !== "PLAYER" ||
      input.operation.targetId !== operationInput.data.playerId
    ) {
      throw new AdminError(
        ADMIN_ERROR_CODES.OPERATION_POLICY_DRIFT,
        "Player identity operation target drift detected",
      );
    }
    if (input.operation.expectedRevision === null) {
      throw new AdminError(
        ADMIN_ERROR_CODES.EXPECTED_REVISION_REQUIRED,
        "Player identity change requires expectedRevision",
      );
    }

    const expectedDigest = adminPlayerIdentityDigest(
      operationInput.data.playerId,
      input.externalId,
    );
    if (expectedDigest !== operationInput.data.newIdentityDigest) {
      throw new AdminError(
        ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "Ephemeral WhatsApp identity does not match the prepared operation",
      );
    }

    await withTransaction(this.pool, async (client) => {
      const operationLock = await client.query<{
        status: string;
        request_fingerprint: string;
      }>(
        `SELECT status, request_fingerprint
         FROM admin_operations
         WHERE id = $1
         FOR UPDATE`,
        [input.operation.id],
      );
      const lockedOperation = operationLock.rows[0];
      if (lockedOperation === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
      }
      if (lockedOperation.status === "APPLIED") return;
      if (
        lockedOperation.status !== "READY" ||
        lockedOperation.request_fingerprint !== input.operation.requestFingerprint
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
          "Player identity operation changed before apply",
        );
      }

      const player = await client.query<{ revision: string }>(
        `SELECT revision::text AS revision
         FROM players
         WHERE id = $1
         FOR UPDATE`,
        [operationInput.data.playerId],
      );
      const playerRow = player.rows[0];
      if (playerRow === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Player not found");
      }
      const currentRevision = BigInt(playerRow.revision);
      if (currentRevision !== input.operation.expectedRevision) {
        throw new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, "Player revision changed", {
          expectedRevision: input.operation.expectedRevision.toString(),
          actualRevision: currentRevision.toString(),
        });
      }

      const identities = await client.query<IdentityRow>(
        `SELECT id, player_id, external_id, status
         FROM player_identities
         WHERE provider = 'baileys'
           AND (player_id = $1 OR external_id = $2)
         ORDER BY player_id, id
         FOR UPDATE`,
        [operationInput.data.playerId, input.externalId],
      );
      const own = identities.rows.filter((row) => row.player_id === operationInput.data.playerId);
      const active = own.filter((row) => row.status === "ACTIVE");
      if (active.length > 1) {
        throw new AdminError(
          ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
          "Player has multiple active Baileys identities; repair is required before changing number",
          { activeIdentityCount: active.length },
        );
      }

      const targetIdentity = identities.rows.find((row) => row.external_id === input.externalId);
      if (
        targetIdentity !== undefined &&
        targetIdentity.player_id !== operationInput.data.playerId
      ) {
        throw new AdminError(
          ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
          "WhatsApp identity is already bound to another player",
        );
      }

      const currentIdentity = active[0] ?? null;
      const alreadyActive = targetIdentity?.status === "ACTIVE";
      const changed = !alreadyActive;
      let activatedIdentityId = targetIdentity?.id ?? null;
      let nextRevision = currentRevision;

      if (changed) {
        if (currentIdentity !== null) {
          await client.query(
            `UPDATE player_identities
             SET status = 'REVOKED', revoked_at = now()
             WHERE id = $1 AND status = 'ACTIVE'`,
            [currentIdentity.id],
          );
        }

        if (targetIdentity !== undefined) {
          const reactivated = await client.query(
            `UPDATE player_identities
             SET status = 'ACTIVE', revoked_at = NULL
             WHERE id = $1 AND player_id = $2 AND status = 'REVOKED'`,
            [targetIdentity.id, operationInput.data.playerId],
          );
          if (reactivated.rowCount !== 1) {
            throw new AdminError(
              ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED,
              "Revoked WhatsApp identity could not be reactivated safely",
            );
          }
          activatedIdentityId = targetIdentity.id;
        } else {
          activatedIdentityId = randomUUID();
          await client.query(
            `INSERT INTO player_identities(id, player_id, provider, external_id, status)
             VALUES ($1, $2, 'baileys', $3, 'ACTIVE')`,
            [activatedIdentityId, operationInput.data.playerId, input.externalId],
          );
        }

        const bumped = await client.query<{ revision: string }>(
          `UPDATE players
           SET revision = revision + 1, updated_at = now()
           WHERE id = $1 AND revision = $2
           RETURNING revision::text AS revision`,
          [operationInput.data.playerId, currentRevision.toString()],
        );
        const bumpedRow = bumped.rows[0];
        if (bumpedRow === undefined) {
          throw new AdminError(
            ADMIN_ERROR_CODES.REVISION_CONFLICT,
            "Player revision changed during identity update",
          );
        }
        nextRevision = BigInt(bumpedRow.revision);
      }

      const beforeData = {
        playerRevision: currentRevision.toString(),
        whatsapp:
          currentIdentity === null
            ? null
            : {
                identityId: currentIdentity.id,
                status: "ACTIVE",
                last4: externalIdentityLast4(currentIdentity.external_id),
              },
      } as const;
      const afterData = {
        playerRevision: nextRevision.toString(),
        whatsapp: {
          identityId: activatedIdentityId,
          status: "ACTIVE",
          last4: operationInput.data.newIdentityLast4,
        },
      } as const;

      await completeAppliedAdminOperationWithClient(client, {
        operation: input.operation,
        actorPrincipalId: input.actorPrincipalId,
        resourceType: "PLAYER_IDENTITY",
        resourceId: activatedIdentityId,
        beforeData,
        afterData,
        result: {
          changed,
          playerRevision: nextRevision.toString(),
          newIdentityLast4: operationInput.data.newIdentityLast4,
        },
        auditMetadata: {
          provider: "baileys",
          sensitiveExternalIdStored: false,
        },
      });
    });

    const final = await this.adminRepository.getOperation(input.operation.id);
    if (final === null) throw new Error("Player identity operation disappeared after apply");
    return final;
  }
}
