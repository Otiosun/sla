import type { Pool, PoolClient } from "pg";
import type { PlayerId, EncounterId, CorrelationId } from "../../shared-kernel/ids.js";
import type { CaptureAttemptResult } from "../capture/contracts.js";
import { appError, err, type Result } from "../../shared-kernel/result.js";
import { ExpeditionIncidentalCaptureAction, type IncidentalCaptureMenuSnapshot } from "./expedition-incidental-capture-action.js";
import type { IncidentalEncounterPanel, IncidentalAction } from "./expedition-v4-incidental-panel.js";

/**
 * Immutable menu receipt: this MUST be written using the SAME PostgreSQL
 * transaction that authorizes presentation and its current inventory mapping.
 * Merely rendering a panel does not issue a receipt.
 *
 * A later WhatsApp dispatcher must load by player + original server-issued
 * menu ID. Neither menu JSON nor Ball item IDs may come from inbound text.
 */
export interface StoredIncidentalMenu {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly outcomeId: string;
  readonly encounterId: EncounterId;
  readonly encounterRevision: bigint;
  readonly snapshot: IncidentalCaptureMenuSnapshot;
}

interface MenuRow {
  id: string;
  player_id: string;
  outcome_id: string;
  encounter_id: string;
  encounter_revision: string;
  menu: unknown;
  ball_item_ids: unknown;
}

const UUID = /^[a-f0-9-]{36}$/iu;
const BALLS = ["POKE", "GREAT", "ULTRA"] as const;

function decode(row: MenuRow): StoredIncidentalMenu | null {
  if (!UUID.test(row.id) || !UUID.test(row.outcome_id) || !UUID.test(row.encounter_id) ||
      !UUID.test(row.player_id) || !/^(0|[1-9][0-9]*)$/u.test(row.encounter_revision)) return null;
  const menu = row.menu as Partial<IncidentalEncounterPanel> | null;
  if (!menu || typeof menu !== "object" ||
      menu.encounterId !== row.encounter_id ||
      menu.encounterRevision !== row.encounter_revision ||
      typeof menu.text !== "string" || !Array.isArray(menu.choices) ||
      !menu.choices.every((c: IncidentalAction) =>
        c && (c.kind === "BATTLE" && c.optionNo === 1 ||
        c.kind === "IGNORE" && c.optionNo === 0 ||
        c.kind === "CAPTURE" && BALLS.includes(c.ball) &&
          c.optionNo === BALLS.indexOf(c.ball) + 2))) return null;
  const ids = row.ball_item_ids as Record<string, unknown> | null;
  if (!ids || typeof ids !== "object" || Array.isArray(ids) ||
      Object.entries(ids).some(([kind, id]) => !BALLS.includes(kind as typeof BALLS[number]) ||
        typeof id !== "string" || !UUID.test(id))) return null;
  const hydrated: IncidentalEncounterPanel = {
    visible: typeof menu.visible === "string" ? menu.visible : "",
    expanded: typeof menu.expanded === "string" ? menu.expanded : "",
    text: menu.text,
    padded: menu.padded === true,
    choices: menu.choices as IncidentalAction[],
    encounterId: row.encounter_id,
    encounterRevision: BigInt(row.encounter_revision),
  };
  return {
    id: row.id,
    playerId: row.player_id as PlayerId,
    outcomeId: row.outcome_id,
    encounterId: row.encounter_id as EncounterId,
    encounterRevision: BigInt(row.encounter_revision),
    snapshot: { outcomeId: row.outcome_id, menu: hydrated, ballItemIds: ids as StoredIncidentalMenu["snapshot"]["ballItemIds"] },
  };
}

export class PostgresIncidentalMenuStore {
  public constructor(private readonly pool: Pool) {}

  /** caller owns transaction; never open a second pool/transaction here */
  public async issue(client: PoolClient, input: StoredIncidentalMenu): Promise<void> {
    if (!UUID.test(input.id) || !UUID.test(input.outcomeId) ||
        input.snapshot.outcomeId !== input.outcomeId ||
        input.snapshot.menu.encounterId !== input.encounterId ||
        input.snapshot.menu.encounterRevision !== input.encounterRevision ||
        !decode({
          id: input.id, player_id: input.playerId, outcome_id: input.outcomeId,
          encounter_id: input.encounterId, encounter_revision: String(input.encounterRevision),
          menu: { ...input.snapshot.menu, encounterRevision: String(input.encounterRevision) },
          ball_item_ids: input.snapshot.ballItemIds,
        })) throw new Error("Invalid trusted incidental menu");
    const payload = { ...input.snapshot.menu, encounterRevision: String(input.encounterRevision) };
    const inserted = await client.query(
      `INSERT INTO solo_incidental_menu_snapshots
       (id, player_id, outcome_id, encounter_id, encounter_revision, menu, ball_item_ids)
       SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb
       WHERE EXISTS (
         SELECT 1 FROM solo_expedition_search_outcomes o
         JOIN solo_expeditions e ON e.id=o.expedition_id AND e.player_id=o.player_id
         JOIN encounters c ON c.id=o.encounter_id AND c.player_id=o.player_id
         WHERE o.id=$3 AND o.player_id=$2 AND o.encounter_id=$4
           AND o.kind='INCIDENTAL' AND e.phase='ACTIVE' AND c.status='ENGAGED'
       ) ON CONFLICT DO NOTHING RETURNING id`,
      [input.id, input.playerId, input.outcomeId, input.encounterId,
       String(input.encounterRevision), JSON.stringify(payload),
       JSON.stringify(input.snapshot.ballItemIds)],
    );
    if (inserted.rowCount !== 1) throw new Error("Menu could not be issued or has already been issued");
  }

  public async load(playerId: PlayerId, menuId: string): Promise<StoredIncidentalMenu | null> {
    if (!UUID.test(menuId)) return null;
    const result = await this.pool.query<MenuRow>(
      `SELECT m.id, m.player_id, m.outcome_id, m.encounter_id,
              m.encounter_revision::text, m.menu, m.ball_item_ids
       FROM solo_incidental_menu_snapshots m
       WHERE m.id=$1 AND m.player_id=$2`,
      [menuId, playerId],
    );
    const row = result.rows[0];
    return row ? decode(row) : null;
  }
}

/** Server-side dispatcher seam. Only the original menu ID is selected by the
 * authenticated session. The text choice never carries a menu or item ID. */
export class StoredIncidentalCaptureDispatch {
  public constructor(
    private readonly store: Pick<PostgresIncidentalMenuStore, "load">,
    private readonly action: ExpeditionIncidentalCaptureAction,
  ) {}
  public async execute(input: {
    playerId: PlayerId; menuId: string; rawChoice: string;
    expectedEncounterId: EncounterId; expectedEncounterRevision: bigint;
    idempotencyKey: string; correlationId: CorrelationId; causationId: string | null;
  }): Promise<Result<CaptureAttemptResult>> {
    const issued = await this.store.load(input.playerId, input.menuId);
    if (!issued) return err(appError("FLOW_BLOCKED", "No issued incidental menu for this trainer"));
    if (issued.encounterId !== input.expectedEncounterId ||
        issued.encounterRevision !== input.expectedEncounterRevision)
      return err(appError("REVISION_CONFLICT", "Issued incidental menu is stale"));
    return this.action.execute({ ...input, snapshot: issued.snapshot });
  }
}
