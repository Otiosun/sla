import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

interface TravelRecoveryRow {
  readonly expedition_id: string;
  readonly expedition_revision: string;
  readonly world_revision: string;
  readonly destination_area_id: string;
  readonly destination_slug: string;
  readonly display_name: string;
  readonly elapsed_minutes: string;
  readonly travel_minutes: string;
  readonly phase: string;
  readonly fingerprint: string;
}

/**
 * No mutation: reconstruct the exact already-committed travel response after
 * the WhatsApp Inbox crashed before completion. Both immutable receipts,
 * PUBLISHED connection, origin/destination and original claimed Inbox must
 * prove the same player, message, release and author-approved minute cost.
 * Only composed in synthetic WHATSAPP_ENABLED=false staging.
 */
export class PostgresExpeditionTravelConfirmationRecovery {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  public async resolve(input: {
    readonly playerId: PlayerId;
    readonly context: MessageHandlerContext;
  }): Promise<
    Result<{
      readonly destinationDisplayName: string;
      readonly travelMinutes: number;
      readonly elapsedMinutes: number;
      readonly phase: "ACTIVE" | "ENDED";
    } | null>
  > {
    const message = input.context.message;
    const path = /^\/explorar\s+viajar\s+(vila-dos-arrozais|campos-de-yun)$/iu.exec(
      message.text?.trim() ?? "",
    );
    if (
      !expeditionOperationAllowed(input.playerId) ||
      message.provider !== "baileys" ||
      path === null
    ) {
      return ok(null);
    }
    const scope = parseIdempotencyScope("world.travel");
    if (!scope.ok) return scope;
    const key = createIdempotencyKey(scope.value, input.context.idempotencyKey);
    if (!key.ok) return key;

    const found = await this.pool.query<TravelRecoveryRow>(
      `SELECT receipt.expedition_id::text AS expedition_id,
              receipt.result->'expedition'->>'revision' AS expedition_revision,
              world.expected_revision::text AS world_revision,
              world.destination_area_id::text AS destination_area_id,
              destination.slug AS destination_slug,
              destination_revision.display_name,
              receipt.result->'expedition'->>'elapsedMinutes' AS elapsed_minutes,
              connection_revision.access_rule->>'explorationMinutes' AS travel_minutes,
              receipt.result->'expedition'->>'phase' AS phase,
              receipt.fingerprint
       FROM inbox_messages inbox
       JOIN player_identities identity
         ON identity.provider=inbox.provider
        AND identity.external_id=$5
        AND identity.player_id=$2
        AND identity.status='ACTIVE'
       JOIN solo_expedition_receipts receipt
         ON receipt.player_id=identity.player_id
        AND receipt.idempotency_key=$3
        AND receipt.operation='ACTION_TRAVEL'
       JOIN world_travel_receipts world
         ON world.player_id=receipt.player_id
        AND world.idempotency_key=$8
        AND world.destination_area_id::text=receipt.result->'expedition'->>'areaId'
       JOIN areas destination ON destination.id=world.destination_area_id
       JOIN areas source ON source.id=world.from_area_id
         AND source.region_id=destination.region_id
       JOIN area_revisions destination_revision
         ON destination_revision.area_id=destination.id
        AND destination_revision.content_release_id=world.content_release_id
        AND destination_revision.active=TRUE
       JOIN area_connections connection
         ON connection.from_area_id=world.from_area_id
        AND connection.to_area_id=world.destination_area_id
       JOIN area_connection_revisions connection_revision
         ON connection_revision.connection_id=connection.id
        AND connection_revision.content_release_id=world.content_release_id
        AND connection_revision.active=TRUE
       WHERE inbox.id=$1
         AND inbox.provider='baileys'
         AND inbox.status='PROCESSING'
         AND inbox.external_message_id=$6
         AND inbox.payload_hash=$4
         AND inbox.normalized_payload->>'senderRef'=$5
         AND inbox.normalized_payload->>'chatRef'=$7
         AND lower(trim(inbox.normalized_payload->>'text'))=lower($9)
         AND destination.slug=$10
         AND destination.slug IN ('vila-dos-arrozais','campos-de-yun')
         AND source.slug IN ('vila-dos-arrozais','campos-de-yun')
       LIMIT 2`,
      [
        input.context.inboxMessageId,
        input.playerId,
        input.context.idempotencyKey,
        incomingMessageFingerprint(message),
        message.senderRef,
        message.externalMessageId,
        message.chatRef,
        key.value.storageKey,
        message.text?.trim(),
        path[1]?.toLowerCase(),
      ],
    );
    const receipt = found.rows[0];
    if (receipt === undefined) return ok(null);
    if (found.rows.length !== 1) {
      return err(appError("FLOW_BLOCKED", "Ambiguous committed travel recovery"));
    }
    if (
      !/^[a-f0-9-]{36}$/iu.test(receipt.expedition_id) ||
      !/^[a-f0-9-]{36}$/iu.test(receipt.destination_area_id) ||
      !/^[1-9][0-9]*$/u.test(receipt.expedition_revision) ||
      !/^(0|[1-9][0-9]*)$/u.test(receipt.world_revision)
    ) {
      return err(appError("FLOW_BLOCKED", "Committed travel identifiers are invalid"));
    }
    const revision = BigInt(receipt.expedition_revision);
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "ACTION_TRAVEL",
          receipt.expedition_id,
          (revision - 1n).toString(),
          receipt.world_revision,
          receipt.destination_area_id,
        ]),
      )
      .digest("hex");
    const elapsedMinutes = Number(receipt.elapsed_minutes);
    const travelMinutes = Number(receipt.travel_minutes);
    if (
      receipt.fingerprint !== expected ||
      !Number.isSafeInteger(elapsedMinutes) ||
      elapsedMinutes < 1 ||
      elapsedMinutes > 720 ||
      !Number.isSafeInteger(travelMinutes) ||
      travelMinutes < 1 ||
      travelMinutes > elapsedMinutes ||
      !["ACTIVE", "ENDED"].includes(receipt.phase)
    ) {
      return err(appError("FLOW_BLOCKED", "Committed travel evidence is inconsistent"));
    }
    return ok({
      destinationDisplayName: receipt.display_name,
      travelMinutes,
      elapsedMinutes,
      phase: receipt.phase as "ACTIVE" | "ENDED",
    });
  }
}
