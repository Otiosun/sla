import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { RulesetConfigSchema, EffectConfigSchemas } from "../../modules/catalog/contracts.js";
import {
  renderExpeditionV4IncidentalPanel,
  type IncidentalEncounterPanel,
  type IncidentalBallKind,
} from "../../modules/exploration/expedition-v4-incidental-panel.js";
import type { IncidentalCaptureMenuSnapshot } from "../../modules/exploration/expedition-incidental-capture-action.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { PlayerId } from "../../shared-kernel/ids.js";

const choiceSchema = z.discriminatedUnion("kind", [
  z.object({ optionNo: z.literal(1), kind: z.literal("BATTLE") }),
  z.object({ optionNo: z.union([z.literal(2),z.literal(3),z.literal(4)]),
    kind: z.literal("CAPTURE"), ball: z.enum(["POKE","GREAT","ULTRA"]) }),
  z.object({ optionNo: z.literal(0), kind: z.literal("IGNORE") }),
]);
const panelSchema = z.object({
  visible:z.string().max(5000), expanded:z.string().max(5000),
  text:z.string().max(9000), padded:z.boolean(),
  encounterId:z.string().uuid(), encounterRevision:z.string().regex(/^\d+$/u),
  choices:z.array(choiceSchema).min(1).max(5),
}).strict();
const mappingSchema = z.object({
  POKE:z.string().uuid().optional(),
  GREAT:z.string().uuid().optional(),
  ULTRA:z.string().uuid().optional(),
}).strict();
type StoredPanel = z.infer<typeof panelSchema>;
interface ReceiptRow {
  id:string; player_id:string; outcome_id:string;
  encounter_id:string; encounter_revision:string;
  panel:unknown; ball_item_ids:unknown;
}
interface BallRow { id:string; slug:string; quantity:string; effect_config:unknown }
export interface IssuedIncidentalMenu extends IncidentalCaptureMenuSnapshot {
  readonly menuId:string;
}

function decode(row:ReceiptRow):Result<IssuedIncidentalMenu> {
  const panel=panelSchema.safeParse(row.panel);
  const mapping=mappingSchema.safeParse(row.ball_item_ids);
  if (!panel.success || !mapping.success ||
    panel.data.encounterId!==row.encounter_id ||
    panel.data.encounterRevision!==row.encounter_revision) {
    return err(appError("INVALID_STATE_TRANSITION","Persisted incidental menu is invalid"));
  }
  const menu:IncidentalEncounterPanel={
    ...panel.data, encounterRevision:BigInt(panel.data.encounterRevision),
  };
  for(const choice of menu.choices) {
    if(choice.kind==="CAPTURE" && (
      choice.optionNo!==({POKE:2,GREAT:3,ULTRA:4} as const)[choice.ball] ||
      mapping.data[choice.ball]===undefined)) {
      return err(appError("INVALID_STATE_TRANSITION","Persisted Ball mapping is invalid"));
    }
  }
  return ok({menuId:row.id,outcomeId:row.outcome_id,menu,ballItemIds:mapping.data});
}

/**
 * Issue once from trusted state, and recover the exact sent menu on retry.
 * Does not authorize gameplay; the CaptureService validates encounter,
 * ruleset and balance again when a player acts.
 */
export class PostgresIncidentalMenuSnapshots {
  public constructor(private readonly pool:Pool) {}

  public async issue(input:{
    readonly playerId:PlayerId;
    readonly outcomeId:string;
    readonly canBattle:boolean;
    readonly canIgnore:boolean;
    readonly combiningCount:number;
  }):Promise<Result<IssuedIncidentalMenu>> {
    if (!z.string().uuid().safeParse(input.outcomeId).success ||
      !Number.isSafeInteger(input.combiningCount) ||
      input.combiningCount<0 || input.combiningCount>600) {
      return err(appError("VALIDATION_FAILED","Invalid incidental menu issuance"));
    }
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize duplicate attempts to issue one menu to the same trainer.
      const player=await client.query(
        "SELECT id FROM players WHERE id=$1 AND status='ACTIVE' AND EXISTS (SELECT 1 FROM onboarding_states WHERE player_id=$1 AND state='COMPLETE') FOR UPDATE",
        [input.playerId],
      );
      if(player.rowCount!==1) {
        await client.query("ROLLBACK");
        return err(appError("PLAYER_INELIGIBLE","Trainer not found"));
      }
      const previous=await client.query<ReceiptRow>(
        "SELECT * FROM solo_incidental_menu_snapshots WHERE player_id=$1 AND outcome_id=$2",
        [input.playerId,input.outcomeId],
      );
      if(previous.rows[0]!==undefined) {
        const replay=decode(previous.rows[0]);
        await client.query("COMMIT");
        return replay;
      }
      const current=await client.query<{
        encounter_id:string; encounter_revision:string;
        display_name:string; level:string; release_id:string; ruleset_config:unknown;
      }>(
        `SELECT encounter.id::text AS encounter_id,
                encounter.revision::text AS encounter_revision,
                species.display_name, wild.pokemon_snapshot->>'level' AS level,
                release.id::text AS release_id, ruleset.config AS ruleset_config
         FROM solo_expedition_search_outcomes outcome
         JOIN solo_expeditions expedition
           ON expedition.id=outcome.expedition_id
          AND expedition.player_id=outcome.player_id
         JOIN encounters encounter
           ON encounter.id=outcome.encounter_id
          AND encounter.player_id=outcome.player_id
          AND encounter.area_id=expedition.area_id
         JOIN encounter_wild_snapshots wild
           ON wild.encounter_id=encounter.id
          AND wild.wild_no=1 AND wild.status='ACTIVE'
         JOIN content_release_pointers pointer ON pointer.pointer_key='ACTIVE'
         JOIN content_releases release
           ON release.id=pointer.content_release_id AND release.status='PUBLISHED'
          AND encounter.content_release_id=release.id
         JOIN rulesets ruleset
           ON ruleset.id=encounter.ruleset_id AND ruleset.status='PUBLISHED'
         JOIN pokemon_species_revisions species
           ON species.content_release_id=release.id AND species.active=TRUE
          AND species.species_id=(wild.pokemon_snapshot->>'speciesId')::uuid
         WHERE outcome.id=$1 AND outcome.player_id=$2 AND outcome.kind='INCIDENTAL'
           AND expedition.phase='ACTIVE' AND encounter.status='ENGAGED'
         FOR SHARE OF encounter`,
        [input.outcomeId,input.playerId],
      );
      const row=current.rows[0];
      if(row===undefined) {
        await client.query("ROLLBACK");
        return err(appError("FLOW_BLOCKED","No current published incidental encounter"));
      }
      const rules=RulesetConfigSchema.safeParse(row.ruleset_config);
      if(!rules.success) {
        await client.query("ROLLBACK");
        return err(appError("FLOW_BLOCKED","Invalid pinned Capture ruleset"));
      }
      const allowed=(rules.data.capture.allowedEncounterStates ?? ["ENGAGED","IN_BATTLE"])
        .includes("ENGAGED");
      const ballRows=await client.query<BallRow>(
        `SELECT item.id::text AS id,item.slug,balance.quantity::text,
                revision.effect_config
         FROM inventory_balances balance
         JOIN items item ON item.id=balance.item_id
         JOIN item_revisions revision ON revision.item_id=item.id
           AND revision.content_release_id=$2 AND revision.active=TRUE
           AND revision.item_kind='BALL' AND revision.effect_key='catch-modifier'
         WHERE balance.player_id=$1 AND balance.quantity>0
           AND item.slug IN ('poke-ball','great-ball','ultra-ball')
         ORDER BY item.slug`,
        [input.playerId,row.release_id],
      );
      const mapping:Partial<Record<IncidentalBallKind,string>>={};
      const balls:Array<{kind:IncidentalBallKind;quantity:number;captureAuthorized:boolean}>=[];
      const bySlug:Readonly<Record<string,IncidentalBallKind>>={
        "poke-ball":"POKE","great-ball":"GREAT","ultra-ball":"ULTRA",
      };
      for(const ball of ballRows.rows) {
        const kind=bySlug[ball.slug];
        const quantity=Number(ball.quantity);
        if(kind===undefined || !Number.isSafeInteger(quantity) ||
          quantity<=0 || quantity>9999 ||
          !EffectConfigSchemas["catch-modifier"].safeParse(ball.effect_config).success) continue;
        balls.push({kind,quantity,captureAuthorized:allowed});
        if(allowed)mapping[kind]=ball.id;
      }
      const view=renderExpeditionV4IncidentalPanel({
        source:"INCIDENTAL", encounterStatus:"ENGAGED",
        encounterId:row.encounter_id,encounterRevision:BigInt(row.encounter_revision),
        speciesName:row.display_name,level:Number(row.level),
        canBattle:input.canBattle,canIgnore:input.canIgnore,
        balls,ignoreMinutes:10,combiningCount:input.combiningCount,
      });
      if(!view.ok) {
        await client.query("ROLLBACK");
        return view;
      }
      const payload:StoredPanel={...view.value,
        choices:[...view.value.choices],
        encounterRevision:view.value.encounterRevision.toString()};
      const menuId=randomUUID();
      await client.query(
        `INSERT INTO solo_incidental_menu_snapshots
           (id,player_id,outcome_id,encounter_id,encounter_revision,panel,ball_item_ids)
         VALUES ($1,$2,$3,$4,$5::bigint,$6::jsonb,$7::jsonb)`,
        [menuId,input.playerId,input.outcomeId,row.encounter_id,row.encounter_revision,
          JSON.stringify(payload),JSON.stringify(mapping)],
      );
      await client.query("COMMIT");
      return ok({menuId,outcomeId:input.outcomeId,menu:view.value,ballItemIds:mapping});
    } catch(e) {
      try{await client.query("ROLLBACK")}catch{/* already rolled back */}
      throw e;
    } finally {client.release()}
  }

  public async findForPlayer(playerId:PlayerId,menuId:string):
    Promise<Result<IssuedIncidentalMenu>> {
    if(!z.string().uuid().safeParse(menuId).success) {
      return err(appError("VALIDATION_FAILED","Invalid incidental menu reference"));
    }
    const found=await this.pool.query<ReceiptRow>(
      "SELECT * FROM solo_incidental_menu_snapshots WHERE player_id=$1 AND id=$2",
      [playerId,menuId],
    );
    return found.rows[0]===undefined
      ? err(appError("FLOW_BLOCKED","No menu issued to this trainer"))
      : decode(found.rows[0]);
  }
}
