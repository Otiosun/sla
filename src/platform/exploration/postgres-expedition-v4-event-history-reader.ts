import type { Pool } from "pg";
import type { PlayerId } from "../../shared-kernel/ids.js";
import type { ExpeditionPeriod } from "../../modules/exploration/expedition-clock.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { withTransaction } from "../db/transaction.js";

export type ExpeditionEventKind =
  | "PREPARE"
  | "CHANGE_PERIOD"
  | "SEARCH"
  | "RESOURCES"
  | "FOLLOW_TRAIL"
  | "TRAVEL"
  | "IGNORE"
  | "ADVANCE"
  | "END"
  | "BATTLE_STARTED"
  | "CAPTURED"
  | "CAPTURE_FAILED";

export interface ExpeditionFactualEvent {
  readonly kind: ExpeditionEventKind;
  readonly occurredAt: Date;
  readonly elapsedMinutes: number | null;
  readonly description: string;
  readonly receiptRef: string;
}

export interface ExpeditionFactualEventPage {
  readonly period: ExpeditionPeriod;
  readonly endReason: "VOLUNTARY" | "CLOCK" | "BLACKOUT";
  readonly elapsedMinutes: number;
  readonly page: number;
  readonly pages: number;
  readonly totalEvents: number;
  readonly events: readonly ExpeditionFactualEvent[];
}

interface ExpeditionRow {
  readonly id: string;
  readonly period: ExpeditionPeriod;
  readonly end_reason: "VOLUNTARY" | "CLOCK" | "BLACKOUT";
  readonly elapsed_minutes: number;
}
interface ReceiptRow {
  readonly idempotency_key: string;
  readonly operation: string;
  readonly created_at: Date;
  readonly result: unknown;
  readonly search_kind: string | null;
  readonly search_revision: string | null;
  readonly resource_kind: string | null;
  readonly resource_revision: string | null;
  readonly resource_quantity: string | null;
  readonly resource_item_name: string | null;
  readonly resource_ledger: string | null;
  readonly resource_ledger_proven: string | null;
  readonly trail_source: string | null;
  readonly trail_direct: string | null;
  readonly trail_revision: string | null;
  readonly trail_name: string | null;
  readonly trail_level: number | null;
  readonly ignore_encounter: string | null;
}
interface CanonicalRow {
  readonly kind: "BATTLE_STARTED" | "CAPTURED" | "CAPTURE_FAILED";
  readonly event_id: string;
  readonly created_at: Date;
}

const PAGE_SIZE = 12;
const MAX_EVENTS = 10_000;

function safeLabel(value: string | null): string | null {
  if (
    value === null ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 70 ||
    /[\r\n*_~`<>\u031d]/u.test(value) ||
    value.includes("[Ler mais]") ||
    /\p{Cc}/u.test(value)
  )
    return null;
  return value;
}

function receiptEvent(row: ReceiptRow, expeditionId: string): Result<ExpeditionFactualEvent> {
  if (
    row.result === null ||
    typeof row.result !== "object" ||
    Array.isArray(row.result) ||
    !(row.created_at instanceof Date) ||
    Number.isNaN(row.created_at.getTime())
  )
    return err(appError("FLOW_BLOCKED", "Invalid persisted expedition event"));
  const obj = row.result as Record<string, unknown>;
  const snap = obj.expedition;
  if (snap === null || typeof snap !== "object" || Array.isArray(snap)) {
    return err(appError("FLOW_BLOCKED", "Expedition event has no durable snapshot"));
  }
  const state = snap as Record<string, unknown>;
  const elapsed = state.elapsedMinutes;
  if (
    state.expeditionId !== expeditionId ||
    !Number.isSafeInteger(elapsed) ||
    typeof elapsed !== "number" ||
    elapsed < 0 ||
    elapsed > 720 ||
    typeof state.revision !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(state.revision)
  )
    return err(appError("FLOW_BLOCKED", "Expedition event snapshot is inconsistent"));
  const revision = BigInt(state.revision);
  let kind: ExpeditionEventKind;
  let description: string;
  const ref = obj.effectRef;
  switch (row.operation) {
    case "PREPARE":
      kind = "PREPARE";
      description = "Preparação registrada";
      break;
    case "CHANGE_PERIOD":
      kind = "CHANGE_PERIOD";
      description = "Período alterado";
      break;
    case "ACTION_SEARCH_FREE": {
      if (
        typeof ref !== "string" ||
        !["NO_SIGNAL", "TRAIL", "INCIDENTAL", "DIRECT"].includes(row.search_kind ?? "") ||
        row.search_revision === null ||
        BigInt(row.search_revision) !== revision - 1n
      )
        return err(appError("FLOW_BLOCKED", "Search receipt has no canonical outcome"));
      kind = "SEARCH";
      description =
        row.search_kind === "NO_SIGNAL"
          ? "Busca: nenhum sinal"
          : row.search_kind === "TRAIL"
            ? "Busca: rastros encontrados"
            : row.search_kind === "INCIDENTAL"
              ? "Busca: encontro incidental registrado"
              : "Busca: encontro direto registrado";
      break;
    }
    case "ACTION_RESOURCE_SEARCH": {
      if (
        typeof ref !== "string" ||
        (row.resource_kind !== "ITEM" && row.resource_kind !== "NONE") ||
        row.resource_revision === null ||
        BigInt(row.resource_revision) !== revision - 1n ||
        row.resource_quantity === null ||
        !/^(0|[1-9][0-9]*)$/u.test(row.resource_quantity)
      )
        return err(appError("FLOW_BLOCKED", "Resource receipt has no durable result"));
      kind = "RESOURCES";
      if (row.resource_kind === "NONE") {
        if (row.resource_quantity !== "0" || row.resource_ledger !== null) {
          return err(appError("FLOW_BLOCKED", "No-result resource event claims inventory"));
        }
        description = "Recursos: nenhum item";
      } else {
        const itemName = safeLabel(row.resource_item_name);
        if (
          itemName === null ||
          BigInt(row.resource_quantity) < 1n ||
          row.resource_ledger === null ||
          row.resource_ledger !== row.resource_ledger_proven
        )
          return err(
            appError("FLOW_BLOCKED", "Resource grant is not proven by canonical inventory"),
          );
        description = "Recursos: " + itemName + " ×" + row.resource_quantity;
      }
      break;
    }
    case "ACTION_FOLLOW_TRAIL": {
      const name = safeLabel(row.trail_name);
      if (
        typeof ref !== "string" ||
        row.trail_source === null ||
        row.trail_direct === null ||
        row.trail_revision === null ||
        BigInt(row.trail_revision) !== revision - 1n ||
        name === null ||
        !Number.isSafeInteger(row.trail_level) ||
        row.trail_level === null ||
        row.trail_level < 1 ||
        row.trail_level > 100
      )
        return err(appError("FLOW_BLOCKED", "Trail follow is missing its canonical encounter"));
      kind = "FOLLOW_TRAIL";
      description = "Seguiu rastros: " + name + " · Nv. " + row.trail_level;
      break;
    }
    case "ACTION_TRAVEL":
      kind = "TRAVEL";
      description = "Viagem registrada no Mundo";
      break;
    case "ACTION_IGNORE_INCIDENTAL":
      if (typeof ref !== "string" || row.ignore_encounter !== ref) {
        return err(appError("FLOW_BLOCKED", "Incidental ignore has no matching encounter"));
      }
      kind = "IGNORE";
      description = "Encontro incidental ignorado";
      break;
    case "ADVANCE":
      kind = "ADVANCE";
      description = "Avanço de tempo registrado";
      break;
    case "END":
      kind = "END";
      description =
        state.endReason === "CLOCK"
          ? "Tempo da expedição esgotado"
          : state.endReason === "BLACKOUT"
            ? "Expedição encerrada por derrota total"
            : state.endReason === "VOLUNTARY"
              ? "Expedição encerrada voluntariamente"
              : "Expedição encerrada";
      break;
    default:
      return err(appError("FLOW_BLOCKED", "Unknown persisted expedition operation"));
  }
  return ok({
    kind,
    occurredAt: row.created_at,
    elapsedMinutes: elapsed,
    description,
    receiptRef: row.idempotency_key,
  });
}

/**
 * Read-only immutable evidence, NEVER inferred battle victories, XP, loot,
 * money or approved reports. Includes canonical captures and PvE starts only
 * where their source-issued encounter and database result can be proven.
 */
export class PostgresExpeditionV4EventHistoryReader {
  public constructor(private readonly pool: Pool) {}

  public async readLatestCompleted(
    playerId: PlayerId,
    page = 1,
  ): Promise<Result<ExpeditionFactualEventPage | null>> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      return err(appError("VALIDATION_FAILED", "Invalid expedition history page"));
    }
    return withTransaction(
      this.pool,
      async (client) => {
        const found = await client.query<ExpeditionRow>(
          `SELECT id::text,period,end_reason,elapsed_minutes FROM solo_expeditions
          WHERE player_id=$1 AND phase='ENDED'
          AND end_reason IN ('VOLUNTARY','CLOCK','BLACKOUT')
          ORDER BY updated_at DESC,id DESC LIMIT 1`,
          [playerId],
        );
        const expedition = found.rows[0];
        if (expedition === undefined) return ok(null);

        const receipts = await client.query<ReceiptRow>(
          `SELECT r.idempotency_key,r.operation,r.created_at,r.result,
                  search.kind AS search_kind,search.expedition_revision::text AS search_revision,
                  resource.kind AS resource_kind,resource.expedition_revision::text AS resource_revision,
                  resource.quantity::text AS resource_quantity,
                  item.display_name AS resource_item_name,
                  resource.ledger_id::text AS resource_ledger,
                  ledger.id::text AS resource_ledger_proven,
                  trail.source_outcome_id::text AS trail_source,
                  trail.followed_outcome_id::text AS trail_direct,
                  trail.follow_revision::text AS trail_revision,
                  trail.species_name AS trail_name,trail.encounter_level AS trail_level,
                  ignored.id::text AS ignore_encounter
             FROM solo_expedition_receipts r
             LEFT JOIN solo_expedition_search_outcomes search
               ON r.operation='ACTION_SEARCH_FREE'
              AND search.id::text=r.result->>'effectRef'
              AND search.player_id=r.player_id
              AND search.expedition_id=r.expedition_id
             LEFT JOIN solo_expedition_resource_results resource
               ON r.operation='ACTION_RESOURCE_SEARCH'
              AND resource.id::text=r.result->>'effectRef'
              AND resource.player_id=r.player_id
              AND resource.expedition_id=r.expedition_id
             LEFT JOIN item_revisions item
               ON item.item_id=resource.item_id
              AND item.content_release_id=resource.content_release_id
             LEFT JOIN inventory_ledger ledger
               ON ledger.id=resource.ledger_id
              AND ledger.player_id=resource.player_id
              AND ledger.item_id=resource.item_id
              AND ledger.delta=resource.quantity
              AND ledger.source_type='EXPEDITION_RESOURCE'
              AND ledger.source_id=resource.id::text
             LEFT JOIN solo_expedition_trail_follows trail
               ON r.operation='ACTION_FOLLOW_TRAIL'
              AND trail.id::text=r.result->>'effectRef'
              AND trail.player_id=r.player_id
              AND trail.expedition_id=r.expedition_id
             LEFT JOIN encounters ignored
               ON r.operation='ACTION_IGNORE_INCIDENTAL'
              AND ignored.id::text=r.result->>'effectRef'
              AND ignored.player_id=r.player_id
             WHERE r.player_id=$1 AND r.expedition_id=$2
             ORDER BY r.created_at,r.idempotency_key`,
          [playerId, expedition.id],
        );
        const canonical = await client.query<CanonicalRow>(
          `SELECT 'BATTLE_STARTED'::text AS kind,
                  battle_receipt.battle_id::text AS event_id,
                  battle_receipt.created_at AS created_at
             FROM solo_expedition_battle_receipts battle_receipt
             JOIN solo_expedition_search_outcomes outcome
               ON outcome.id=battle_receipt.outcome_id
              AND outcome.player_id=battle_receipt.player_id
              AND outcome.expedition_id=$2
              AND outcome.encounter_id=battle_receipt.encounter_id
             JOIN battles battle
               ON battle.id=battle_receipt.battle_id
              AND battle.encounter_id=battle_receipt.encounter_id
              AND battle.battle_type='WILD'
             WHERE battle_receipt.player_id=$1
             UNION ALL
             SELECT CASE WHEN attempt.status='CAPTURED'
                           THEN 'CAPTURED' ELSE 'CAPTURE_FAILED' END,
                    attempt.id::text,attempt.created_at
             FROM capture_attempts attempt
             JOIN solo_incidental_menu_snapshots menu
               ON menu.encounter_id=attempt.encounter_id
              AND menu.player_id=attempt.player_id
             JOIN solo_expedition_search_outcomes outcome
               ON outcome.id=menu.outcome_id
              AND outcome.player_id=attempt.player_id
              AND outcome.expedition_id=$2
             WHERE attempt.player_id=$1 AND attempt.battle_id IS NULL
               AND attempt.status IN ('CAPTURED','FAILED')
               AND menu.panel->'actions' ? 'CAPTURE'
               AND EXISTS (
                 SELECT 1 FROM jsonb_each_text(menu.ball_item_ids) offered(choice_no,ball_id)
                 WHERE offered.ball_id=attempt.ball_item_id::text
               )`,
          [playerId, expedition.id],
        );
        const events: ExpeditionFactualEvent[] = [];
        for (const row of receipts.rows) {
          const event = receiptEvent(row, expedition.id);
          if (!event.ok) return event;
          events.push(event.value);
        }
        for (const row of canonical.rows) {
          if (!(row.created_at instanceof Date) || Number.isNaN(row.created_at.getTime())) {
            return err(appError("FLOW_BLOCKED", "Canonical event has no valid timestamp"));
          }
          const kind = row.kind;
          events.push({
            kind,
            occurredAt: row.created_at,
            elapsedMinutes: null,
            description:
              kind === "BATTLE_STARTED"
                ? "Batalha PvE iniciada"
                : kind === "CAPTURED"
                  ? "Captura confirmada"
                  : "Tentativa de captura sem sucesso",
            receiptRef: row.event_id,
          });
        }
        if (events.length > MAX_EVENTS) {
          return err(appError("FLOW_BLOCKED", "Expedition has too many events for a safe report"));
        }
        events.sort(
          (a, b) =>
            a.occurredAt.getTime() - b.occurredAt.getTime() ||
            a.receiptRef.localeCompare(b.receiptRef),
        );
        const pages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
        if (page > pages) return err(appError("VALIDATION_FAILED", "History page does not exist"));
        return ok({
          period: expedition.period,
          endReason: expedition.end_reason,
          elapsedMinutes: expedition.elapsed_minutes,
          page,
          pages,
          totalEvents: events.length,
          events: events.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        });
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
