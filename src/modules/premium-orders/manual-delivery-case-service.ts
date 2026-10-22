import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const CASE_ITEMS = [
  ["TERA","Terastalização",1],["Z","Movimento Z",1],["GMAX","Gigantamax",1],
  ["SAVE+","Save Premium",1],["GEN","Pokémon Gênesis",20],["GYM","Insígnia de Ginásio",1],
  ["RED","Save Red",1],["EGG:COMUM","Ovo Comum",20],["EGG:RARO","Ovo Raro",20],
  ["EGG:ESPECIAL","Ovo Especial",20],["2XP","XP em Dobro",52],
  ["RDX","Rotomdex Ultra",1],["P-U","Pack Ultra",20],["P-E","Pack Especial",20],
  ["CAP","Pack do Capturador",20],["NOITE","Pack Noturno",20],
  ["AQUA","Pack Aquático",20],["CUSTOM","Poké Ball Personalizada",20],
  ["COL","Caixa do Colecionador",20],["KIT","Kit do Treinador",20],
  ["MASTER","Master Ball",20],["ASH","Save Ash",1],["BROCK","Save Brock",1],
  ["CYN","Save Cynthia",1],
] as const;
const CASE_CATALOG = new Map<string, { title: string; maxQuantity: number }>(
  CASE_ITEMS.map(([sku,title,maxQuantity]) => [sku,{title,maxQuantity}]),
);
const Uuid = z.string().uuid();
const Description = z.string().trim().min(8).max(1400);

export const OpenPremiumDeliveryCaseSchema = z.object({
  caseId: Uuid, eventId: Uuid, playerId: Uuid,
  sku: z.string().max(128), quantity: z.number().int().min(1).max(99),
  note: Description,
}).strict();

export const AdvancePremiumDeliveryCaseSchema = z.object({
  caseId: Uuid, eventId: Uuid, expectedRevision: z.number().int().min(0),
  nextState: z.enum(["IN_PROGRESS","CLOSED","CANCELLED","OPEN"]),
  note: Description, attested: z.boolean(),
}).strict().superRefine((input,ctx) => {
  if (input.nextState === "CLOSED" && (!input.attested || input.note.length < 20)) {
    ctx.addIssue({code:"custom",path:["attested"],message:"Closing requires explicit owner attestation and evidence note"});
  }
  if (input.nextState !== "CLOSED" && input.attested) {
    ctx.addIssue({code:"custom",path:["attested"],message:"Attestation is only allowed when closing"});
  }
});

export interface PremiumDeliveryCase {
  id: string; playerId: string; sku: string; title: string; quantity: number;
  state: "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
  revision: number; openingActorPrincipalId: string; createdAt: string; updatedAt: string;
}
interface CaseRow {
  id: string; player_id: string; sku: string; quantity: number;
  state: PremiumDeliveryCase["state"]; revision: string;
  opening_actor_id: string; created_at: Date; updated_at: Date;
}
interface EventRow {
  id: string; case_id: string; actor_principal_id: string;
  next_state: string; note: string; created_at: Date;
}
export interface PremiumDeliveryCaseEvent {
  id: string; caseId: string; actorPrincipalId: string; nextState: string;
  note: string; createdAt: string;
}
const display = (r: CaseRow): PremiumDeliveryCase => ({
  id:r.id, playerId:r.player_id, sku:r.sku, title:CASE_CATALOG.get(r.sku)?.title ?? r.sku,
  quantity:r.quantity, state:r.state, revision:Number(r.revision),
  openingActorPrincipalId:r.opening_actor_id,
  createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString(),
});
const eventView = (r: EventRow): PremiumDeliveryCaseEvent => ({
  id:r.id,caseId:r.case_id,actorPrincipalId:r.actor_principal_id,
  nextState:r.next_state,note:r.note,createdAt:r.created_at.toISOString(),
});
function conflict(code: string) { return {kind:"CONFLICT" as const,code}; }
async function withClient<T>(pool: Pool, run:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const result=await run(client);
    await client.query("COMMIT");
    return result;
  } catch(error) { await client.query("ROLLBACK");throw error; }
  finally {client.release();}
}

export class PremiumDeliveryCaseService {
  constructor(private readonly pool: Pool) {}
  catalog() {
    return CASE_ITEMS.map(([sku,title,maxQuantity]) => ({sku,title,maxQuantity}));
  }
  async list(playerId: string) {
    const rows=await this.pool.query<CaseRow>(
      `SELECT * FROM premium_delivery_cases WHERE player_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 100`,[playerId]);
    return rows.rows.map(display);
  }
  async timeline(caseId:string) {
    const rows=await this.pool.query<EventRow>(
      `SELECT * FROM premium_delivery_case_events WHERE case_id=$1 ORDER BY created_at,id`,[caseId]);
    return rows.rows.map(eventView);
  }
  async open(raw:unknown,actorPrincipalId:string) {
    const input=OpenPremiumDeliveryCaseSchema.parse(raw);
    const item=CASE_CATALOG.get(input.sku);
    if (!item) return {kind:"SKU_UNSUPPORTED" as const};
    if (input.quantity>item.maxQuantity) return {kind:"QUANTITY_LIMIT" as const};
    if (input.caseId===input.eventId) return conflict("INVALID_EVENT_ID");
    return withClient(this.pool,async(client)=>{
      const result=await client.query<CaseRow>(
        `INSERT INTO premium_delivery_cases
         (id,player_id,sku,quantity,state,opening_actor_id)
         SELECT $1,$2,$3,$4,'OPEN',$5
         WHERE EXISTS (SELECT 1 FROM players WHERE id=$2)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [input.caseId,input.playerId,input.sku,input.quantity,actorPrincipalId]);
      const fresh=result.rows[0];
      if (fresh) {
        await client.query(
          `INSERT INTO premium_delivery_case_events
           (id,case_id,actor_principal_id,next_state,note)
           VALUES ($1,$2,$3,'OPEN',$4)`,[input.eventId,input.caseId,actorPrincipalId,input.note]);
        return {kind:"APPLIED" as const,replayed:false,case:display(fresh)};
      }
      const existing=await client.query<CaseRow>(
        "SELECT * FROM premium_delivery_cases WHERE id=$1",[input.caseId]);
      const row=existing.rows[0];
      if (!row) return {kind:"PLAYER_NOT_FOUND" as const};
      const event=await client.query<EventRow>(
        "SELECT * FROM premium_delivery_case_events WHERE id=$1 AND case_id=$2",
        [input.eventId,input.caseId]);
      const first=event.rows[0];
      if(row.player_id!==input.playerId || row.sku!==input.sku ||
         row.quantity!==input.quantity || row.opening_actor_id!==actorPrincipalId ||
         !first || first.actor_principal_id!==actorPrincipalId ||
         first.next_state!=="OPEN" || first.note!==input.note) return conflict("IDEMPOTENCY_CONFLICT");
      return {kind:"APPLIED" as const,replayed:true,case:display(row)};
    });
  }
  async advance(raw:unknown,actorPrincipalId:string) {
    const input=AdvancePremiumDeliveryCaseSchema.parse(raw);
    return withClient(this.pool,async(client)=>{
      const result=await client.query<CaseRow>(
        "SELECT * FROM premium_delivery_cases WHERE id=$1 FOR UPDATE",[input.caseId]);
      const row=result.rows[0];if(!row) return {kind:"NOT_FOUND" as const};
      const previous=await client.query<EventRow>(
        "SELECT * FROM premium_delivery_case_events WHERE id=$1",[input.eventId]);
      const prior=previous.rows[0];
      if(prior) {
        if(prior.case_id!==input.caseId || prior.actor_principal_id!==actorPrincipalId ||
          prior.next_state!==input.nextState || prior.note!==input.note) return conflict("IDEMPOTENCY_CONFLICT");
        return {kind:"APPLIED" as const,replayed:true,case:display(row)};
      }
      if(Number(row.revision)!==input.expectedRevision) return conflict("REVISION_CONFLICT");
      const legal=(row.state==="OPEN" && ["IN_PROGRESS","CANCELLED"].includes(input.nextState)) ||
        (row.state==="IN_PROGRESS" && ["OPEN","CLOSED","CANCELLED"].includes(input.nextState));
      if(!legal) return conflict("INVALID_TRANSITION");
      const updated=await client.query<CaseRow>(
        `UPDATE premium_delivery_cases SET state=$2,revision=revision+1,updated_at=now()
         WHERE id=$1 RETURNING *`,[input.caseId,input.nextState]);
      await client.query(
        `INSERT INTO premium_delivery_case_events
         (id,case_id,actor_principal_id,next_state,note)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.eventId,input.caseId,actorPrincipalId,input.nextState,input.note]);
      return {kind:"APPLIED" as const,replayed:false,case:display(updated.rows[0]!)};
    });
  }
}
