/**
 * Player journey UAT: real operational WhatsApp router + disposable PostgreSQL.
 * Uses synthetic trainers registered by whatsapp_simulator_multi_actor_uat.ts.
 * Reports commands AND committed state. Absolutely never point at production.
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { SimulatedWhatsAppTranscriptEntry } from "../../src/adapters/whatsapp/simulated-whatsapp-adapter.js";
import { UatBootstrapService } from "../../src/modules/admin/uat-bootstrap.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { SystemClock } from "../../src/platform/clock/index.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { CryptoRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { PostgresOperationalUxReadModel } from "../../src/platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPokemonPcStorageRepository } from "../../src/platform/world-services/postgres-pokemon-pc-storage-repository.js";
import { PokemonPcStorageService } from "../../src/modules/world-services/pc-storage-service.js";
import type { PlayerId, PokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";

const url = process.env.DATABASE_URL ?? "";
if (process.env.APP_ENV !== "test" || !url.includes("localhost") || !url.includes("pokemon_rpg_test")) {
  throw new Error("Player journey only runs against explicit disposable local test PostgreSQL");
}
const pool = new Pool({ connectionString: url, max: 8 });
/**
 * Published releases are immutable, correctly! Only the isolated fixture
 * constructor temporarily suspends a particular draft guard, within ONE
 * transaction, then re-enables it before commit. All other triggers, FKs,
 * inventory ledgers and gameplay mutation guards remain untouched.
 * The guard at the start of this script forbids any nonlocal/non-test DB.
 */
const catalogGuard = {
  move_revisions: "trg_move_revisions_draft_only",
  item_revisions: "trg_item_revisions_draft_only",
  evolution_rules: "trg_evolution_rules_draft_only",
} as const;
async function insertSyntheticPublishedFixture(
  table: keyof typeof catalogGuard,
  query: string,
  values: readonly unknown[],
) {
  const client: PoolClient = await pool.connect();
  const trigger = catalogGuard[table];
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const inserted = await client.query(query, [...values]);
    if (inserted.rowCount !== 1) throw new Error(`Synthetic fixture ${table} did not insert exactly one row`);
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
const PLAYER_A = "5599999999101@s.whatsapp.net";
const PLAYER_B = "5599999999102@s.whatsapp.net";
const WORLD = "120363900000000002@g.us";
const key = Buffer.alloc(32, 7);
const operational = createOperationalSimulatedWhatsAppRuntime({
  pool,
  encounterRngConfig: { encryptionKey: key, encryptionKeyVersion: 1 },
  pveBattleConfig: { turnWindowTtlMs: 120_000, maintenanceBatchSize: 50, encryptionKeys: new Map([[1, key]]) },
});
type Outbound = Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>;
type Check = { area: string; actor: string; command: string; expected: string; actual: string; ok: boolean };
const findings: Check[] = [];
let serial = 900_000;
function check(area: string, actor: string, command: string, expected: string, actual: unknown, ok: boolean) {
  const entry = { area, actor, command, expected, actual: typeof actual === "string" ? actual : JSON.stringify(actual), ok };
  findings.push(entry);
  console.log(JSON.stringify({ event: "stage2.player.step", ...entry }));
}
function textOf(entry: Outbound): string {
  const payload = entry.message.payload;
  return entry.message.messageType === "TEXT" ? String(payload.text ?? "") :
    entry.message.messageType === "IMAGE" ? String(payload.caption ?? "") : JSON.stringify(payload);
}
async function send(actor: string, command: string, fixedId?: string, replyTo?: string) {
  const id = fixedId ?? `STAGE2-JOURNEY-${++serial}`;
  const from = operational.adapter.transcript.length;
  await operational.adapter.injectText({
    externalMessageId: id, senderRef: actor, chatRef: WORLD, text: command,
    replyToExternalMessageId: replyTo ?? null,
  });
  await operational.runtime.flushOutbox();
  await new Promise<void>((resolve) => setTimeout(resolve, 550));
  const replies = operational.adapter.transcript.slice(from).filter((entry): entry is Outbound => entry.direction === "OUTBOUND");
  const state = await pool.query<{ status: string; last_error_code: string | null }>(
    "SELECT status,last_error_code FROM inbox_messages WHERE provider='baileys' AND external_message_id=$1",
    [id],
  );
  console.log(JSON.stringify({
    event: "stage2.player.whatsapp", actor, command, messageId: id,
    inbox: state.rows[0] ?? null,
    replies: replies.map(textOf).map((text) => text.slice(0, 800)),
  }));
  return { id, replies: replies.map(textOf), inbox: state.rows[0]?.status ?? null };
}
async function replyLast(actor: string, text: string) {
  const outbound = [...operational.adapter.transcript].reverse().find(
    (item): item is Outbound => item.direction === "OUTBOUND" &&
      item.message.destinationRef === WORLD &&
      typeof item.message.payload.worldServicePrompt === "object",
  );
  if (!outbound) throw new Error("No PC selection prompt available");
  return send(actor, text, undefined, outbound.providerExternalMessageId);
}
async function player(ref: string): Promise<PlayerId> {
  const q = await pool.query<{ player_id: string }>(
    "SELECT player_id::text FROM player_identities WHERE provider='baileys' AND external_id=$1 AND status='ACTIVE'",
    [ref],
  );
  if (!q.rows[0]) throw new Error(`Player fixture missing: ${ref}; run multi-actor UAT first`);
  return q.rows[0].player_id as PlayerId;
}
async function main() {
  try {
    // Explicitly prepare two independent, synthetic players in this disposable DB.
    // This does not conceal the older multi-actor registration regression: that
    // proof runs independently and is tracked as a separate failure.
    const onboardingRepo = new PostgresPlayerOnboardingRepository(pool);
    const starter = new PlayerStarterService(onboardingRepo, new SystemClock(), new CryptoRandomSource());
    const players = new PlayerRegistrationService(onboardingRepo);
    const world = new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null });
    const principal = (await pool.query<{id:string}>(
      "SELECT id::text FROM admin_principals WHERE identity_ref='whatsapp:5599999999000@s.whatsapp.net' LIMIT 1",
    )).rows[0]?.id;
    if (!principal) throw new Error("Synthetic admin fixture missing");
    const bootstrap = new UatBootstrapService(pool, players, starter, world);
    for (const ref of [PLAYER_A, PLAYER_B]) {
      const result = await bootstrap.bootstrap({ provider: "baileys", externalId: ref }, principal);
      check("setup", ref, "test-only onboarding bootstrap",
        "ACTIVE synthetic player with starter and location", result, result.ok);
      if (!result.ok) throw new Error(`Cannot bootstrap synthetic actor: ${ref} ${result.error.code}`);
    }
    const a = await player(PLAYER_A);
    const b = await player(PLAYER_B);
    const reads = new PostgresOperationalUxReadModel(pool);
    const candidates = [a, b];
    const actor = (await reads.activeBattleId(a)) === null ? PLAYER_A : PLAYER_B;
    const owner = actor === PLAYER_A ? a : b;
    const other = actor === PLAYER_A ? b : a;
    const roster = await pool.query<{
      pokemon_instance_id: string; form_id: string; level: number; slot_no: number;
    }>(`SELECT p.id::text AS pokemon_instance_id,p.form_id::text,p.level,r.slot_no
        FROM pokemon_instances p JOIN pokemon_roster_slots r ON r.pokemon_instance_id=p.id
        WHERE p.owner_player_id=$1 AND p.status='ACTIVE' AND r.placement_kind='TEAM'
        ORDER BY r.slot_no LIMIT 1`,[owner]);
    const first = roster.rows[0];
    if (!first) throw new Error("Synthetic trainer has no active Pokémon");
    const pokemonId = first.pokemon_instance_id as PokemonInstanceId;
    const release = (await pool.query<{ id: string }>(
      "SELECT content_release_id::text AS id FROM player_onboarding_context WHERE player_id=$1",
      [owner],
    )).rows[0]?.id;
    if (!release) throw new Error("Trainer has no pinned content release");

    await operational.runtime.start();
    check("journey", actor, "login", "synthetic approved trainer", { playerId: owner, pokemonId, release }, true);
    const profileView = await send(actor, "/perfil");
    check("profile", actor, "/perfil", "trainer identity and ACTIVE status",
      profileView.replies.join(" | "),profileView.replies.some(s=>s.includes("UAT Trainer") && s.includes("ACTIVE")));
    const partyView = await send(actor, "/equipe");
    check("team",actor,"/equipe","starter Pokémon visible",
      partyView.replies.join(" | "),partyView.replies.some(s=>/Bulbasaur|Pokémon/iu.test(s)));
    const sheetView = await send(actor, "/pokemon #1");
    check("pokemon",actor,"/pokemon #1","starter species and move details",
      sheetView.replies.join(" | "),sheetView.replies.some(s=>/Bulbasaur/iu.test(s)));
    const learnsetView = await send(actor, "/aprendizados #1");
    check("moves", actor, "/aprendizados #1",
      "trainer-pinned level learnset and next milestones, not generic TM rewards",
      learnsetView.replies.join(" | "),
      learnsetView.inbox !== "FAILED" && learnsetView.replies.some(
        (message) => message.includes("𝗔𝗣𝗥𝗘𝗡𝗗𝗜𝗭𝗔𝗗𝗢𝗦") && message.includes("Vine Whip"),
      ));
    const before = await send(actor, "/golpes");
    check("moves", actor, "/golpes", "pending choice list or empty state",
      before.replies.join(" | "), before.inbox !== "FAILED" && before.replies.some(s => /MOVIMENTOS|PENDÊNCIAS/iu.test(s)));

    // Create an authentic pending move-learning record in disposable published content.
    const typeId = (await pool.query<{ type_id: string }>(
      "SELECT type1_id::text AS type_id FROM pokemon_form_revisions WHERE content_release_id=$1 AND form_id=$2 LIMIT 1",
      [release, first.form_id],
    )).rows[0]?.type_id;
    if (!typeId) throw new Error("Missing type in published release");
    const moveId = randomUUID(), choiceId = randomUUID();
    await pool.query("INSERT INTO moves(id,slug) VALUES($1,$2)", [moveId, `stage2-jornada-${moveId}`]);
    await insertSyntheticPublishedFixture("move_revisions", `INSERT INTO move_revisions(id,content_release_id,move_id,display_name,type_id,category,power,accuracy,max_pp,active)
      VALUES($1,$2,$3,'Eco da Jornada',$4,'PHYSICAL',40,100,20,TRUE)`, [randomUUID(), release, moveId, typeId]);
    await pool.query(`INSERT INTO pending_move_choices
      (id,pokemon_instance_id,content_release_id,move_id,learn_level,source_type,source_id,correlation_id)
      VALUES($1,$2,$3,$4,$5,'BATTLE_REWARD',$6,$7)`,
      [choiceId,pokemonId,release,moveId,first.level,randomUUID(),randomUUID()]);
    const offer = await send(actor, "/golpes");
    check("moves", actor, "/golpes", "Eco da Jornada offered and shown",
      offer.replies.join(" | "), offer.replies.some(s => s.includes("Eco da Jornada")));
    const invalid = await send(actor, "/aprender 1 9");
    const pending = (await pool.query<{ status: string }>(
      "SELECT status FROM pending_move_choices WHERE id=$1", [choiceId],
    )).rows[0]?.status;
    check("moves", actor, "/aprender 1 9", "invalid slot rejected; choice stays pending",
      { status: pending, messages: invalid.replies }, pending === "PENDING");

    const occupied = await pool.query<{ slot_no: number }>(
      "SELECT slot_no FROM pokemon_move_slots WHERE pokemon_instance_id=$1 ORDER BY slot_no LIMIT 1",
      [pokemonId],
    );
    const slot = occupied.rows[0]?.slot_no;
    if (!slot) throw new Error("Starter has no occupied move slot for replacement");
    const learned = await send(actor, `/aprender 1 ${slot}`);
    const afterChoice = await pool.query<{ status: string }>(
      "SELECT status FROM pending_move_choices WHERE id=$1", [choiceId],
    );
    const slotAfter = await pool.query<{ move_id: string }>(
      "SELECT move_id::text FROM pokemon_move_slots WHERE pokemon_instance_id=$1 AND slot_no=$2",
      [pokemonId,slot],
    );
    check("moves", actor, `/aprender 1 ${slot}`, "choice RESOLVED and exact slot contains new move",
      { status: afterChoice.rows[0]?.status, move: slotAfter.rows[0]?.move_id,
        messages: learned.replies }, afterChoice.rows[0]?.status === "RESOLVED" && slotAfter.rows[0]?.move_id === moveId);
    const noPending = await send(actor, "/golpes");
    check("moves", actor, "/golpes", "no remaining pending choice for trainer",
      noPending.replies.join(" | "), noPending.replies.some(s=>/SEM PENDÊNCIAS/iu.test(s)));
    // Another reward offers the same learned move; the player must safely skip.
    const duplicateChoiceId = randomUUID();
    await pool.query(`INSERT INTO pending_move_choices
      (id,pokemon_instance_id,content_release_id,move_id,learn_level,source_type,source_id,correlation_id)
      VALUES($1,$2,$3,$4,$5,'BATTLE_REWARD',$6,$7)`,
      [duplicateChoiceId,pokemonId,release,moveId,Math.max(1,first.level-1),randomUUID(),randomUUID()]);
    const duplicateOffer=await send(actor,"/golpes");
    check("moves",actor,"/golpes duplicate reward",
      "warns the move is already learned instead of suggesting a damaging replacement",
      duplicateOffer.replies.join(" | "),duplicateOffer.replies.some(s=>/já conhece|não substitua/iu.test(s)));
    const skipped=await send(actor,"/aprender 1 pular");
    const skippedRow=(await pool.query<{status:string}>("SELECT status FROM pending_move_choices WHERE id=$1",
      [duplicateChoiceId])).rows[0]?.status;
    const stillKnown=(await pool.query<{move_id:string}>(
      "SELECT move_id::text FROM pokemon_move_slots WHERE pokemon_instance_id=$1 AND slot_no=$2",
      [pokemonId,slot])).rows[0]?.move_id;
    check("moves",actor,"/aprender 1 pular",
      "duplicate choice SKIPPED; original learned move preserved",
      {status:skippedRow,moveId:stillKnown,replies:skipped.replies},
      skippedRow==="SKIPPED"&&stillKnown===moveId);

    // Seed synthetic evolutionary stone and rule (never in real published content).
    const stoneId = randomUUID();
    // Reuse Bulbasaur's real next species (Ivysaur) rather than a random
    // unrelated species. ONLY the item-based alternate trigger is synthetic.
    const target = await pool.query<{ form_id: string; display_name: string }>(
      `SELECT rule.to_form_id::text AS form_id, species_rev.display_name
       FROM evolution_rules rule
       JOIN pokemon_forms form ON form.id=rule.to_form_id
       JOIN pokemon_species_revisions species_rev
         ON species_rev.content_release_id=rule.content_release_id
        AND species_rev.species_id=form.species_id AND species_rev.active=TRUE
       WHERE rule.content_release_id=$1 AND rule.from_form_id=$2
         AND rule.trigger_kind='LEVEL' AND rule.active=TRUE
       ORDER BY rule.id LIMIT 1`,
      [release,first.form_id],
    );
    const targetForm = target.rows[0]?.form_id;
    if (!targetForm) throw new Error("No second evolution target in synthetic catalog");
    await pool.query("INSERT INTO items(id,slug) VALUES($1,$2)", [stoneId,`pedra-jornada-${stoneId}`]);
    await insertSyntheticPublishedFixture("item_revisions", `INSERT INTO item_revisions
      (id,content_release_id,item_id,display_name,item_kind,effect_key,effect_config,active)
      SELECT $1,$2,$3,'Pedra da Jornada',item_kind,effect_key,effect_config,TRUE
      FROM item_revisions WHERE content_release_id=$2 LIMIT 1`,
      [randomUUID(),release,stoneId]);
    await pool.query(`INSERT INTO inventory_balances(player_id,item_id,quantity)
       VALUES($1,$2,2)`, [owner,stoneId]);
    await insertSyntheticPublishedFixture("evolution_rules", `INSERT INTO evolution_rules(id,content_release_id,from_form_id,to_form_id,trigger_kind,trigger_config,active)
      VALUES($1,$2,$3,$4,'ITEM',$5::jsonb,TRUE)`,
      [randomUUID(),release,first.form_id,targetForm,JSON.stringify({itemId:stoneId})]);
    const options = await send(actor, "/evolucao #1");
    check("evolution", actor, "/evolucao #1", "target and owned evolution stone listed",
      options.replies.join(" | "), options.replies.some(s => s.includes("Pedra da Jornada") && s.includes(target.rows[0]?.display_name ?? "")));
    const wrongOwnerOptions = await reads.listEvolutionOptions(other, pokemonId);
    check("ownership", actor === PLAYER_A ? PLAYER_B : PLAYER_A, "inspect other's Pokémon",
      "no unauthorized evolution options", wrongOwnerOptions, wrongOwnerOptions.length === 0);
    const canonicalOptions = await reads.listEvolutionOptions(owner, pokemonId);
    const itemIndex = canonicalOptions.findIndex(
      (option) => option.triggerKind === "ITEM" && option.itemId === stoneId,
    );
    if (itemIndex < 0) throw new Error("The synthetic evolution stone was not projected");
    const evolveCommand = `/evoluir #1 ${itemIndex + 1}`;
    const autoOption = await send(actor, "/evoluir #1 1");
    const priorForm = (await pool.query<{form_id:string}>(
      "SELECT form_id::text FROM pokemon_instances WHERE id=$1",[pokemonId])).rows[0]?.form_id;
    check("evolution",actor,"/evoluir #1 1 (level rule)",
      "automatically leveled evolutions refuse manual triggering",
      {formId:priorForm,replies:autoOption.replies},
      priorForm===first.form_id && autoOption.replies.some(s=>/automátic/iu.test(s)));
    const otherActor = actor===PLAYER_A ? PLAYER_B : PLAYER_A;
    const rivalOptions = await send(otherActor,"/evolucao #1");
    check("evolution",otherActor,"/evolucao #1 without stone",
      "the other trainer sees the same rule but inventory ×0",
      rivalOptions.replies.join(" | "),
      rivalOptions.replies.some(s=>s.includes("Pedra da Jornada") && s.includes("×0")));
    const denied = await send(otherActor,`/evoluir #1 ${itemIndex+1}`);
    check("evolution",otherActor,"try item evolution without item",
      "server denies with human-readable missing item notice",
      denied.replies.join(" | "),denied.replies.some(s=>/não possui|necessár/iu.test(s)));
    const itemBefore = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",[owner,stoneId]);
    const evo = await send(actor, evolveCommand, "STAGE2-EVOLVE-EXACT-ONCE");
    const state = await pool.query<{ form_id: string }>(
      "SELECT form_id::text FROM pokemon_instances WHERE id=$1",[pokemonId]);
    const itemAfter = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",[owner,stoneId]);
    check("evolution", actor, evolveCommand, "form changed and precisely one stone consumed",
      { forms: state.rows, balanceBefore: itemBefore.rows, balanceAfter:itemAfter.rows,
        replies:evo.replies }, state.rows[0]?.form_id === targetForm &&
        itemBefore.rows[0]?.quantity === "2" && itemAfter.rows[0]?.quantity === "1");
    await send(actor, evolveCommand, "STAGE2-EVOLVE-EXACT-ONCE");
    const replayBalance = (await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM inventory_balances WHERE player_id=$1 AND item_id=$2",[owner,stoneId])).rows[0]?.quantity;
    check("evolution", actor, "replay same WhatsApp message id", "no second item charged",
      { replayBalance }, replayBalance === "1");
    const newSheet=await send(actor,"/pokemon #1");
    check("pokemon",actor,"/pokemon #1 after evolution",
      "new evolved species shown on the actual bot ficha",
      newSheet.replies.join(" | "),
      newSheet.replies.some(s=>s.includes(target.rows[0]?.display_name ?? "")));
    const inventory=await send(actor,"/inventario");
    check("inventory",actor,"/inventario after stone consumption",
      "stone is visible with quantity 1",
      inventory.replies.join(" | "),
      inventory.replies.some(s=>s.includes("Pedra da Jornada")&&/×1|x1|: 1|1 unid/iu.test(s)));

    // The PC/Hub use the same transactional storage owner.
    const boxId = randomUUID();
    await pool.query(`INSERT INTO pokemon_instances
      (id,owner_player_id,form_id,level,current_hp,origin_type)
      VALUES($1,$2,$3,8,24,'TEST')`,[boxId,owner,first.form_id]);
    await pool.query(`INSERT INTO pokemon_roster_slots
      (pokemon_instance_id,player_id,placement_kind,box_no,slot_no)
      VALUES($1,$2,'BOX',1,1)`,[boxId,owner]);
    const storage = new PokemonPcStorageService(new PostgresPokemonPcStorageRepository(pool));
    const lastMember = await storage.move({playerId:owner,pokemonInstanceId:pokemonId,
      target:{placementKind:"BOX",boxNo:1,slotNo:2}});
    check("team-box",actor,"send last team Pokémon to empty slot", "must reject LAST_TEAM_MEMBER",
      lastMember, !lastMember.ok && lastMember.error.code==="ACTION_INVALID");
    const cross = await storage.move({playerId:other,pokemonInstanceId:pokemonId,
      target:{placementKind:"BOX",boxNo:1,slotNo:2}});
    check("ownership","other trainer","move foreign Pokémon", "must reject NOT_FOUND",
      cross,!cross.ok && cross.error.code==="NOT_FOUND");
    const swap = await storage.move({playerId:owner,pokemonInstanceId:boxId as PokemonInstanceId,
      target:{placementKind:"TEAM",boxNo:null,slotNo:first.slot_no}});
    const slots=await pool.query<{pokemon_instance_id:string; placement_kind:string; box_no:number|null; slot_no:number}>(
      "SELECT pokemon_instance_id::text,placement_kind,box_no,slot_no FROM pokemon_roster_slots WHERE player_id=$1 ORDER BY placement_kind,slot_no",
      [owner]);
    check("team-box",actor,"move Box Pokémon into occupied team slot",
      "atomic exchange, still 1 team member", {swap,roster:slots.rows},
      swap.ok && slots.rows.filter(s=>s.placement_kind==="TEAM").length===1 &&
        slots.rows.some(s=>s.pokemon_instance_id===boxId&&s.placement_kind==="TEAM") &&
        slots.rows.some(s=>s.pokemon_instance_id===pokemonId&&s.placement_kind==="BOX"));
    const pc=await send(actor,"/pc");
    check("pc narrative",actor,"/pc without entering center","guided gate to enter Pokémon Center",
      pc.replies.join(" | "),
      pc.inbox!=="FAILED" && pc.replies.some(s=>/centro pokémon|centropokemon/iu.test(s)));
    const arrival = [
      "O treinador para diante do Centro Pokémon e contempla a fachada iluminada.",
      "Ele ajusta a mochila, confere a Poké Ball no cinto e caminha até a porta.",
      "Depois de entrar, cumprimenta a atendente e procura o terminal de armazenamento.",
      "A intenção é guardar seus Pokémon com calma, respeitando o ambiente e o atendimento.",
    ].join("\n");
    const roleplay = await send(actor,arrival);
    check("narrative",actor,"narrar chegada ao Centro Pokémon",
      "scene proof processed",roleplay.replies.join(" | "), roleplay.inbox==="PROCESSED");
    const center = await send(actor,"/centropokemon");
    check("pc narrative",actor,"/centropokemon",
      "center service presents user-visible instructions",
      center.replies.join(" | "),center.inbox==="PROCESSED" && center.replies.length>0);
    const pcEntered = await send(actor,"/pc");
    check("pc narrative",actor,"/pc after scene and entry",
      "PC storage menu, or explicit actionable availability response",
      pcEntered.replies.join(" | "),pcEntered.inbox==="PROCESSED" && pcEntered.replies.length>0);
    const boxes = await send(actor,"/caixas");
    check("pc narrative",actor,"/caixas",
      "Box roster or explicit entry guidance",
      boxes.replies.join(" | "),boxes.inbox==="PROCESSED" && boxes.replies.length>0);
    const deposit=await send(actor,"/depositar");
    check("pc narrative",actor,"/depositar",
      "deposit flow gives user-visible menu or cannot remove the last team member",
      deposit.replies.join(" | "),deposit.inbox==="PROCESSED"&&deposit.replies.length>0);

    // A last-team-member deposit now ends immediately without an impossible prompt.
    // Follow-up numeric text must not trigger a mutation without a valid quoted selection.
    check("pc conversation",actor,"/depositar with one active member",
      "blocked immediately without an actionable selection",
      deposit.replies.join(" | "),
      deposit.replies.some(s=>s.includes("𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢 𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗢")));
    const teamBeforeStray=await pool.query<{n:string}>(
      "SELECT count(*)::text AS n FROM pokemon_roster_slots WHERE player_id=$1 AND placement_kind='TEAM'",[owner]);
    const strayNumber=await send(actor,"01");
    const teamAfterStray=await pool.query<{n:string}>(
      "SELECT count(*)::text AS n FROM pokemon_roster_slots WHERE player_id=$1 AND placement_kind='TEAM'",[owner]);
    check("pc conversation",actor,"unquoted 01 after blocked deposit",
      "no Pokémon leaves the single-member team",
      {replies:strayNumber.replies,before:teamBeforeStray.rows,after:teamAfterStray.rows},
      teamBeforeStray.rows[0]?.n==="1" && teamAfterStray.rows[0]?.n==="1"
        && !strayNumber.replies.some(s=>s.includes("𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢")));
    const withdrawMenu=await send(actor,"/retirar");
    check("pc conversation",actor,"/retirar",
      "stored Ivysaur offered for return to team",
      withdrawMenu.replies.join(" | "),
      withdrawMenu.replies.some(s=>/RETI(RAR|RADA)|𝗥𝗘𝗧𝗜𝗥𝗔𝗥/iu.test(s)&&s.includes("Ivysaur")));
    const withdrawChoice=await replyLast(actor,"01");
    check("pc conversation",actor,"reply 01 / select Ivysaur",
      "withdraw confirmation prompt",
      withdrawChoice.replies.join(" | "),
      withdrawChoice.replies.some(s=>/CONFIRMAR|𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥/iu.test(s)));
    const withdrawn=await replyLast(actor,"01");
    const partyAfterWithdraw=await pool.query<{pokemon_instance_id:string}>(
      "SELECT pokemon_instance_id::text FROM pokemon_roster_slots WHERE player_id=$1 AND placement_kind='TEAM'",[owner]);
    check("pc conversation",actor,"reply 01 / confirm withdraw",
      "Ivysaur returned to team and DB team now has 2 Pokémon",
      {replies:withdrawn.replies,party:partyAfterWithdraw.rows},
      partyAfterWithdraw.rows.length===2 &&
      withdrawn.replies.some(s=>/RETIRAD|𝗥𝗘𝗧𝗜𝗥𝗔𝗗𝗢/iu.test(s)));
    const depositMenu2=await send(actor,"/depositar");
    check("pc conversation",actor,"/depositar with 2 on team",
      "bot lists both active Pokémon",depositMenu2.replies.join(" | "),
      depositMenu2.replies.some(s=>s.includes("Bulbasaur")&&s.includes("Ivysaur")));
    const depositChoice=await replyLast(actor,"01");
    check("pc conversation",actor,"reply 01 / select Bulbasaur",
      "preview Box destination before commit",
      depositChoice.replies.join(" | "),
      depositChoice.replies.some(s=>/DEPÓSITO|𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢/iu.test(s)));
    const committed=await replyLast(actor,"01");
    const afterDeposit=await pool.query<{pokemon_instance_id:string;placement_kind:string}>(
      "SELECT pokemon_instance_id::text,placement_kind FROM pokemon_roster_slots WHERE player_id=$1 ORDER BY placement_kind,slot_no",[owner]);
    check("pc conversation",actor,"reply 01 / confirm deposit",
      "one Pokémon stored and one remains active",
      {replies:committed.replies,roster:afterDeposit.rows},
      committed.replies.some(s=>/ARMAZENAD|𝗔𝗥𝗠𝗔𝗭𝗘𝗡𝗔𝗗𝗢/iu.test(s)) &&
      afterDeposit.rows.filter(s=>s.placement_kind==="TEAM").length===1 &&
      afterDeposit.rows.filter(s=>s.placement_kind==="BOX").length===1);
    const organizeMenu=await send(actor,"/organizar");
    check("pc conversation",actor,"/organizar","stored Pokémon offered",
      organizeMenu.replies.join(" | "),organizeMenu.replies.some(s=>/𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗥/iu.test(s)));
    const organizedSelected=await replyLast(actor,"01");
    check("pc conversation",actor,"reply 01 / choose stored Pokémon",
      "destination input format shown",
      organizedSelected.replies.join(" | "),
      organizedSelected.replies.some(s=>/2\/5|2 5/iu.test(s)));
    const organizedDestination=await replyLast(actor,"2/5");
    check("pc conversation",actor,"reply 2/5 / choose new Box",
      "source and destination preview",
      organizedDestination.replies.join(" | "),
      organizedDestination.replies.some(s=>/Caixa 02|𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢/iu.test(s)));
    const organizedConfirmed=await replyLast(actor,"01");
    const updated=await pool.query<{box_no:number|null;slot_no:number}>(
      "SELECT box_no,slot_no FROM pokemon_roster_slots WHERE pokemon_instance_id=$1",[boxId]);
    check("pc conversation",actor,"reply 01 / confirm organize",
      "Box 2 slot 5 persisted",
      {replies:organizedConfirmed.replies,position:updated.rows[0]},
      organizedConfirmed.replies.some(s=>/𝗖𝗔𝗜𝗫𝗔 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗗𝗔/iu.test(s)) &&
      updated.rows[0]?.box_no===2 && updated.rows[0]?.slot_no===5);
    const finalBoxes=await send(actor,"/caixas");
    check("pc conversation",actor,"/caixas / after move",
      "Box 2 contains relocated Bulbasaur",
      finalBoxes.replies.join(" | "),finalBoxes.replies.some(s=>s.includes("Bulbasaur")&&s.includes("Caixa 02")));

    const bugs=findings.filter(x=>!x.ok);
    console.log(JSON.stringify({event:"stage2.player.complete",actor,
      checks:findings.length,passed:findings.length-bugs.length,bugs:bugs.length,findings}));
    if(bugs.length)throw new Error(`Player journey has ${bugs.length} failing scenario(s)`);
  } finally {
    await operational.runtime.stop().catch(()=>{});
    await pool.end();
  }
}
await main();
