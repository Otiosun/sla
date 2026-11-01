import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface DeliveredExpeditionEncounter {
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: string;
  readonly areaId: string;
  readonly encounterRevision: bigint;
  readonly encounterStatus: "CREATED" | "PRESENTED" | "ENGAGED";
}

export interface ExpeditionSearchSentProofInput {
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: string;
  readonly outboxMessageId: string;
  readonly destinationRef: string;
}

/**
 * SHADOW/STAGING only, NOT composed into the live bot. A pre-send menu binding
 * or a WhatsApp ID alone DOES NOT prove delivery. Require the canonical Outbox
 * row marked SENT by OutboxWorker after adapter.send() returns, and match its
 * immutable owner/outcome/encounter anchor plus the exact private destination.
 *
 * This is a local database SENT acknowledgement, NOT a handset read receipt.
 */
export class PostgresExpeditionSearchSentProof {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async confirm(
    input: ExpeditionSearchSentProofInput,
  ): Promise<Result<DeliveredExpeditionEncounter>> {
    if (
      ![input.outcomeId, input.encounterId, input.outboxMessageId].every((id) =>
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id),
      ) ||
      // A caller-provided destination that matches an Outbox row does NOT
      // prove it was a private chat: a group JID could otherwise pass all
      // SENT/owner/outcome checks and open the encounter from a group send.
      // Accept only direct Baileys user/LID JIDs, never @g.us, broadcasts,
      // newsletters, bare numbers, or arbitrary provider destinations.
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(input.destinationRef)
    ) {
      return err(appError("VALIDATION_FAILED", "Invalid delivery proof reference"));
    }
    const found = await this.pool.query<{
      player_id: string;
      encounter_id: string;
      area_id: string;
      revision: string;
      status: "CREATED" | "PRESENTED" | "ENGAGED";
    }>(
      `SELECT outcome.player_id::text AS player_id,
              encounter.id::text AS encounter_id,
              encounter.area_id::text AS area_id,
              encounter.revision::text AS revision,
              encounter.status
         FROM outbox_messages outbox
         JOIN solo_expedition_search_outcomes outcome
           ON outcome.id=$2 AND outcome.player_id=$3
          AND outcome.encounter_id=$4 AND outcome.kind IN ('DIRECT','INCIDENTAL')
         JOIN solo_expeditions expedition
           ON expedition.id=outcome.expedition_id
          AND expedition.player_id=outcome.player_id
          AND expedition.phase='ACTIVE'
         JOIN encounters encounter
           ON encounter.id=outcome.encounter_id
          AND encounter.player_id=outcome.player_id
          AND encounter.area_id=expedition.area_id
          AND encounter.status IN ('CREATED','PRESENTED','ENGAGED')
         JOIN content_release_pointers pointer
           ON pointer.pointer_key='ACTIVE'
         JOIN content_releases release
           ON release.id=pointer.content_release_id
          AND release.status='PUBLISHED'
          AND encounter.content_release_id=release.id
        -- JSONB ->> returns TEXT; UUID-typed params need explicit casts.
        -- Without these casts PostgreSQL raises 42883 instead of proving SENT.
        WHERE outbox.id=$1
          AND outbox.channel='whatsapp'
          AND outbox.message_type='TEXT'
          AND outbox.status='SENT'
          AND outbox.sent_at IS NOT NULL
          AND outbox.destination_ref=$5
          AND outbox.payload->'expeditionSearch'->>'playerId'=$3::text
          AND outbox.payload->'expeditionSearch'->>'outcomeId'=$2::text
          AND outbox.payload->'expeditionSearch'->>'encounterId'=$4::text
          AND length(outbox.payload->>'text')>0`,
      [
        input.outboxMessageId,
        input.outcomeId,
        input.playerId,
        input.encounterId,
        input.destinationRef,
      ],
    );
    const row = found.rows[0];
    if (
      found.rows.length !== 1 ||
      row === undefined ||
      row.player_id !== input.playerId ||
      row.encounter_id !== input.encounterId ||
      !/^[a-f0-9-]{36}$/iu.test(row.area_id) ||
      !["CREATED", "PRESENTED", "ENGAGED"].includes(row.status) ||
      !/^\d+$/u.test(row.revision)
    ) {
      return err(appError("FLOW_BLOCKED", "No matching SENT search result for this encounter"));
    }
    return ok({
      playerId: input.playerId,
      outcomeId: input.outcomeId,
      encounterId: input.encounterId,
      areaId: row.area_id,
      encounterRevision: BigInt(row.revision),
      encounterStatus: row.status,
    });
  }
}
