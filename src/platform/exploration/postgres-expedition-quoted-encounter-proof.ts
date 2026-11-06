import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface ExpeditionQuotedEncounter {
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: string;
  readonly encounterRevision: bigint;
}

/**
 * Staging-only, read-only authority check for quoted private search results.
 * Never interprets an arbitrary menu number as consent to spend a Ball or
 * start PvE. The eventual action route must perform a fresh canonical check
 * and use the inbound idempotency key in its own transaction.
 */
export class PostgresExpeditionQuotedEncounterProof {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async resolve(input: {
    readonly provider: string;
    readonly playerId: PlayerId;
    readonly senderRef: string;
    readonly chatRef: string;
    readonly replyToExternalMessageId: string | null;
  }): Promise<Result<ExpeditionQuotedEncounter>> {
    const quote = input.replyToExternalMessageId;
    if (
      input.provider !== "baileys" ||
      input.chatRef !== input.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(input.senderRef) ||
      !/^[a-f0-9]{32}$/iu.test(quote ?? "")
    ) {
      return err(appError("FLOW_BLOCKED", "Private quoted encounter is required"));
    }

    const found = await this.pool.query<{
      player_id: string;
      outcome_id: string;
      encounter_id: string;
      revision: string;
    }>(
      `SELECT outcome.player_id::text AS player_id,
              outcome.id::text AS outcome_id,
              encounter.id::text AS encounter_id,
              encounter.revision::text AS revision
         FROM outbox_messages outbox
         JOIN solo_expedition_search_outcomes outcome
           ON outcome.id::text = outbox.payload->'expeditionSearch'->>'outcomeId'
          AND outcome.player_id = $3
          AND outcome.kind IN ('DIRECT', 'INCIDENTAL')
         JOIN solo_expeditions expedition
           ON expedition.id = outcome.expedition_id
          AND expedition.player_id = outcome.player_id
          AND expedition.phase = 'ACTIVE'
         JOIN encounters encounter
           ON encounter.id = outcome.encounter_id
          AND encounter.player_id = outcome.player_id
          AND encounter.area_id = expedition.area_id
          AND encounter.status = 'ENGAGED'
          AND (encounter.expires_at IS NULL OR encounter.expires_at>clock_timestamp())
         JOIN content_release_pointers pointer
           ON pointer.pointer_key = 'ACTIVE'
         JOIN content_releases release
           ON release.id = pointer.content_release_id
          AND release.status = 'PUBLISHED'
          AND encounter.content_release_id = release.id
        WHERE outbox.channel = 'whatsapp'
          AND outbox.message_type = 'TEXT'
          AND outbox.status = 'SENT'
          AND outbox.sent_at IS NOT NULL
          AND outbox.destination_ref = $2
          AND upper(replace(outbox.id::text, '-', '')) = upper($1)
          AND outbox.payload->'expeditionSearch'->>'playerId' = $3::text
          AND outbox.payload->'expeditionSearch'->>'encounterId' = encounter.id::text
          AND length(outbox.payload->>'text') > 0
        LIMIT 2`,
      [quote, input.senderRef, input.playerId],
    );
    const row = found.rows[0];
    if (
      found.rows.length !== 1 ||
      row === undefined ||
      row.player_id !== input.playerId ||
      !/^[a-f0-9-]{36}$/iu.test(row.outcome_id) ||
      !/^[a-f0-9-]{36}$/iu.test(row.encounter_id) ||
      !/^[0-9]+$/u.test(row.revision)
    ) {
      return err(appError("FLOW_BLOCKED", "Quoted encounter is not current and authorized"));
    }
    return ok({
      playerId: input.playerId,
      outcomeId: row.outcome_id,
      encounterId: row.encounter_id,
      encounterRevision: BigInt(row.revision),
    });
  }
}
