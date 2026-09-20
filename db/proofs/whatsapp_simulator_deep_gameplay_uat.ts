import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { SimulatedWhatsAppTranscriptEntry } from "../../src/adapters/whatsapp/simulated-whatsapp-adapter.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const _RECEPTION = "120363900000000001@g.us";
const WORLD = "120363900000000002@g.us";
const OWNER_ADMIN = "5599999999000@s.whatsapp.net";
const PLAYER_A = "5599999999101@s.whatsapp.net";
const PLAYER_B = "5599999999102@s.whatsapp.net";

interface Finding {
  readonly severity: "PASS" | "INFO" | "WARN" | "BUG" | "GAP";
  readonly area: string;
  readonly actor: string;
  readonly action: string;
  readonly observation: string;
}

interface SendResult {
  readonly inboxStatus: string | null;
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
  readonly outbound: readonly Extract<
    SimulatedWhatsAppTranscriptEntry,
    { direction: "OUTBOUND" }
  >[];
}

const findings: Finding[] = [];
let sequence = 10_000;

function add(
  severity: Finding["severity"],
  area: string,
  actor: string,
  action: string,
  observation: string,
): void {
  findings.push({ severity, area, actor, action, observation });
  console.log(
    JSON.stringify({
      event: "sim.deep.finding",
      severity,
      area,
      actor,
      action,
      observation,
    }),
  );
}

function actorName(ref: string): string {
  if (ref === OWNER_ADMIN) return "owner-admin";
  if (ref === PLAYER_A) return "player-a";
  if (ref === PLAYER_B) return "player-b";
  return ref;
}

function textOf(
  entry: Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>,
): string {
  const payload = entry.message.payload;
  if (entry.message.messageType === "TEXT") {
    return typeof payload.text === "string" ? payload.text : "";
  }
  if (entry.message.messageType === "IMAGE") {
    return typeof payload.caption === "string" ? payload.caption : "";
  }
  return JSON.stringify(payload);
}

function scene(label: string): string {
  return [
    `${label}: o treinador observa o lugar antes de entrar.`,
    "Ele guarda o Rotom, confere a mochila e procura a entrada com calma.",
    "Depois de alguns instantes, segue até o balcão e cumprimenta quem estiver atendendo.",
    "A intenção é usar o serviço como parte natural da cena, sem cortar a interpretação.",
  ].join("\n");
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const key = Buffer.alloc(32, 7);
  const operational = createOperationalSimulatedWhatsAppRuntime({
    pool,
    encounterRngConfig: { encryptionKey: key, encryptionKeyVersion: 1 },
    pveBattleConfig: {
      turnWindowTtlMs: 120_000,
      maintenanceBatchSize: 50,
      encryptionKeys: new Map([[1, key]]),
    },
  });
  const adapter = operational.adapter;
  let cursor = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const newOutbound = (): readonly Extract<
    SimulatedWhatsAppTranscriptEntry,
    { direction: "OUTBOUND" }
  >[] => {
    const output = adapter.transcript
      .slice(cursor)
      .filter(
        (entry): entry is Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }> =>
          entry.direction === "OUTBOUND",
      );
    cursor = adapter.transcript.length;
    return output;
  };

  const send = async (input: {
    readonly actor: string;
    readonly chat?: string;
    readonly text: string;
    readonly mentions?: readonly string[];
    readonly replyTo?: string | null;
  }): Promise<SendResult> => {
    sequence += 1;
    const externalMessageId = `DEEP-${sequence}`;
    cursor = adapter.transcript.length;
    await adapter.injectText({
      externalMessageId,
      senderRef: input.actor,
      chatRef: input.chat ?? WORLD,
      text: input.text,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
      replyToExternalMessageId: input.replyTo ?? null,
    });
    await operational.runtime.flushOutbox();
    await sleep(700);

    const inbox = await pool.query<{
      status: string;
      result_ref_type: string | null;
      result_ref_id: string | null;
      last_error_code: string | null;
    }>(
      `SELECT status,result_ref_type,result_ref_id,last_error_code
       FROM inbox_messages
       WHERE provider='baileys' AND external_message_id=$1`,
      [externalMessageId],
    );
    const row = inbox.rows[0];
    if (row?.status === "FAILED") {
      add(
        "BUG",
        "messaging",
        actorName(input.actor),
        input.text,
        `inbox FAILED: ${row.last_error_code ?? "unknown"}`,
      );
    }
    return {
      inboxStatus: row?.status ?? null,
      resultRefType: row?.result_ref_type ?? null,
      resultRefId: row?.result_ref_id ?? null,
      outbound: newOutbound(),
    };
  };

  const latestOutbound = (
    chat = WORLD,
  ): Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }> | null => {
    for (let index = adapter.transcript.length - 1; index >= 0; index -= 1) {
      const entry = adapter.transcript[index];
      if (
        entry !== undefined &&
        entry.direction === "OUTBOUND" &&
        entry.message.destinationRef === chat
      ) {
        return entry;
      }
    }
    return null;
  };

  const replyLast = async (actor: string, text: string): Promise<SendResult> => {
    const previous = latestOutbound();
    if (previous === null) throw new Error("No simulator outbound available for reply");
    return send({
      actor,
      text,
      replyTo: previous.providerExternalMessageId,
    });
  };

  const playerIdFor = async (externalId: string): Promise<string> => {
    const result = await pool.query<{ player_id: string }>(
      `SELECT player_id
       FROM player_identities
       WHERE provider='baileys' AND external_id=$1 AND status='ACTIVE'`,
      [externalId],
    );
    const playerId = result.rows[0]?.player_id;
    if (playerId === undefined) throw new Error(`Player not found for ${externalId}`);
    return playerId;
  };

  try {
    await operational.runtime.start();
    cursor = adapter.transcript.length;

    const playerAId = await playerIdFor(PLAYER_A);
    const playerBId = await playerIdFor(PLAYER_B);

    // How much of the six-area release is actually reachable?
    const topology = await pool.query<{
      slug: string;
      reachable: boolean;
    }>(
      `WITH RECURSIVE
         active_release AS (
           SELECT content_release_id AS id
           FROM content_release_pointers
           WHERE pointer_key='ACTIVE'
         ),
         active_areas AS (
           SELECT area.id, area.slug
           FROM active_release release
           JOIN area_revisions revision
             ON revision.content_release_id=release.id AND revision.active=TRUE
           JOIN areas area ON area.id=revision.area_id
           JOIN regions region ON region.id=area.region_id
           WHERE region.slug='zhoulia'
         ),
         start_area AS (
           SELECT area.id
           FROM active_release release
           JOIN area_revisions revision
             ON revision.content_release_id=release.id
            AND revision.active=TRUE
            AND (revision.data->>'startingArea')::boolean IS TRUE
           JOIN areas area ON area.id=revision.area_id
           JOIN regions region ON region.id=area.region_id
           WHERE region.slug='zhoulia'
           LIMIT 1
         ),
         reachable(id) AS (
           SELECT id FROM start_area
           UNION
           SELECT connection.to_area_id
           FROM reachable current
           JOIN area_connections connection ON connection.from_area_id=current.id
           JOIN active_release release ON TRUE
           JOIN area_connection_revisions revision
             ON revision.content_release_id=release.id
            AND revision.connection_id=connection.id
            AND revision.active=TRUE
         )
       SELECT area.slug, EXISTS(SELECT 1 FROM reachable WHERE reachable.id=area.id) AS reachable
       FROM active_areas area
       ORDER BY area.slug`,
    );
    const unreachable = topology.rows.filter((row) => !row.reachable).map((row) => row.slug);
    add(
      unreachable.length === 0 ? "PASS" : "GAP",
      "world-topology",
      "system",
      "reachable active Zhoulia",
      `active=${topology.rows.length}, reachable=${topology.rows.length - unreachable.length}, unreachable=${unreachable.join(", ") || "none"}`,
    );

    const currency = await pool.query<{ id: string }>(
      "SELECT id FROM currency_definitions WHERE slug='pokedollar'",
    );
    const currencyId = currency.rows[0]?.id;
    if (currencyId === undefined) throw new Error("PokéDollar currency missing");

    const initialKit = await pool.query<{ money: string; balls: string }>(
      `SELECT
         COALESCE((
           SELECT amount::text
           FROM wallet_balances
           WHERE player_id=$1 AND currency_id=$2
         ), '0') AS money,
         COALESCE((
           SELECT balance.quantity::text
           FROM inventory_balances balance
           JOIN items item ON item.id=balance.item_id
           WHERE balance.player_id=$1 AND item.slug='poke-ball'
         ), '0') AS balls`,
      [playerBId, currencyId],
    );
    const initialKitRow = initialKit.rows[0];
    add(
      initialKitRow?.money === "2000" && initialKitRow.balls === "5" ? "PASS" : "BUG",
      "economy",
      "player-b",
      "initial trainer kit",
      JSON.stringify(initialKitRow ?? null),
    );

    // Natural roleplay is the admission token for a facility visit.
    const sceneProof = await send({ actor: PLAYER_B, text: scene("Poké Mart") });
    add(
      sceneProof.resultRefType === "WORLD_SERVICE_SCENE_PROOF" ? "PASS" : "BUG",
      "world-services",
      "player-b",
      "four-line scene proof",
      `resultRefType=${sceneProof.resultRefType ?? "null"}`,
    );

    const mart = await send({ actor: PLAYER_B, text: "/pokemart" });
    add(
      mart.outbound.some((entry) => /POKÉ MART|Poké Mart/iu.test(textOf(entry))) ? "PASS" : "BUG",
      "world-services",
      "player-b",
      "/pokemart after narration",
      mart.outbound.map(textOf).join(" | ") || "no response",
    );

    const catalog = await send({ actor: PLAYER_B, text: "/comprar" });
    add(
      catalog.outbound.some((entry) => /PRATELEIRAS|Poké Ball/iu.test(textOf(entry)))
        ? "PASS"
        : "BUG",
      "economy",
      "player-b",
      "/comprar",
      catalog.outbound.map(textOf).join(" | ") || "catalog missing",
    );

    await replyLast(PLAYER_B, "01");
    const starterPurchase = await replyLast(PLAYER_B, "Poké Ball / 5");
    const starterPurchaseText = starterPurchase.outbound.map(textOf).join(" | ");
    add(
      "INFO",
      "economy",
      "player-b",
      "buy 5 Poké Balls from initial kit",
      starterPurchaseText || "purchase produced no response",
    );

    const afterStarterPurchase = await pool.query<{ balls: string; money: string }>(
      `SELECT
         COALESCE((
           SELECT balance.quantity::text
           FROM inventory_balances balance
           JOIN items item ON item.id=balance.item_id
           WHERE balance.player_id=$1 AND item.slug='poke-ball'
         ), '0') AS balls,
         COALESCE((
           SELECT amount::text FROM wallet_balances
           WHERE player_id=$1 AND currency_id=$2
         ), '0') AS money`,
      [playerBId, currencyId],
    );
    add(
      afterStarterPurchase.rows[0]?.balls === "10" && afterStarterPurchase.rows[0]?.money === "1000"
        ? "PASS"
        : "BUG",
      "economy",
      "player-b",
      "initial-kit purchase persistence",
      JSON.stringify(afterStarterPurchase.rows[0] ?? null),
    );

    await send({ actor: PLAYER_B, text: "/comprar" });
    await replyLast(PLAYER_B, "01");
    const insufficient = await replyLast(PLAYER_B, "Poké Ball / 6");
    const insufficientText = insufficient.outbound.map(textOf).join(" | ");
    const afterInsufficient = await pool.query<{ balls: string; money: string }>(
      `SELECT
         COALESCE((
           SELECT balance.quantity::text
           FROM inventory_balances balance
           JOIN items item ON item.id=balance.item_id
           WHERE balance.player_id=$1 AND item.slug='poke-ball'
         ), '0') AS balls,
         COALESCE((
           SELECT amount::text FROM wallet_balances
           WHERE player_id=$1 AND currency_id=$2
         ), '0') AS money`,
      [playerBId, currencyId],
    );
    add(
      afterInsufficient.rows[0]?.balls === "10" && afterInsufficient.rows[0]?.money === "1000"
        ? "PASS"
        : "BUG",
      "economy",
      "insufficient funds preserve balances",
      JSON.stringify({
        response: insufficientText,
        balances: afterInsufficient.rows[0] ?? null,
      }),
    );

    // Continue only through a real audited AdminService operation, not SQL state fabrication.
    const owner = await pool.query<{ id: string }>(
      "SELECT id FROM admin_principals WHERE identity_ref=$1 AND status='ACTIVE'",
      [`whatsapp:${OWNER_ADMIN}`],
    );
    const ownerPrincipalId = owner.rows[0]?.id;
    if (ownerPrincipalId === undefined) throw new Error("Simulator owner admin missing");

    const economy = new EconomyService(new PostgresEconomyRepository(pool));
    const progression = new ProgressionService(new PostgresProgressionRepository(pool));
    const adminRepository = new PostgresAdminRepository(pool);
    const admin = new AdminService(
      registerPhase12CDomainAdminOperations(
        createPhase12AdminOperationRegistry(adminRepository),
        new AdminDomainOperationService(
          economy,
          progression,
          new PostgresAdminOperationCompletion(pool),
        ),
      ),
      adminRepository,
    );

    const walletGrant = await admin.prepareMutation({
      principalId: ownerPrincipalId,
      operationType: "wallet.adjust",
      input: {
        playerId: playerBId,
        currencyId,
        delta: "2000",
      },
      reason:
        "Autonomous simulator UAT: verify audited wallet adjustment after starter-kit spending",
      idempotencyKey: "sim-deep-wallet-player-b",
      correlationId: randomUUID(),
    });
    const walletApplied = await admin.apply(walletGrant.operation.id, ownerPrincipalId);
    add(
      walletApplied.status === "APPLIED" ? "PASS" : "BUG",
      "admin-economy",
      "owner-admin",
      "wallet.adjust +2000",
      JSON.stringify(walletApplied.result ?? null),
    );

    await send({ actor: PLAYER_B, text: "/comprar" });
    await replyLast(PLAYER_B, "01");
    const purchase = await replyLast(PLAYER_B, "Poké Ball / 5");
    const purchaseText = purchase.outbound.map(textOf).join(" | ");
    add(
      "INFO",
      "economy",
      "player-b",
      "buy 5 Poké Balls after admin funding",
      purchaseText || "purchase produced no response",
    );

    const afterPurchase = await pool.query<{ balls: string; money: string }>(
      `SELECT
         COALESCE((
           SELECT balance.quantity::text
           FROM inventory_balances balance
           JOIN items item ON item.id=balance.item_id
           WHERE balance.player_id=$1 AND item.slug='poke-ball'
         ), '0') AS balls,
         COALESCE((
           SELECT amount::text FROM wallet_balances
           WHERE player_id=$1 AND currency_id=$2
         ), '0') AS money`,
      [playerBId, currencyId],
    );
    add(
      afterPurchase.rows[0]?.balls === "15" && afterPurchase.rows[0]?.money === "2000"
        ? "PASS"
        : "BUG",
      "economy",
      "player-b",
      "purchase persistence",
      JSON.stringify(afterPurchase.rows[0] ?? null),
    );

    await send({ actor: PLAYER_B, text: "/sair" });

    // Fishing is a player-initiated encounter path in the starting village.
    const fish = await send({ actor: PLAYER_B, text: "/pescar" });
    add(
      fish.outbound.length > 0 ? "PASS" : "BUG",
      "fishing",
      "player-b",
      "/pescar in Vila dos Arrozais",
      fish.outbound.map(textOf).join(" | ") || "no fishing feedback",
    );

    let encounterId = fish.resultRefType === "ENCOUNTER" ? fish.resultRefId : null;
    if (encounterId === null) {
      const spawn = await send({
        actor: OWNER_ADMIN,
        text: `/spawn @${PLAYER_B.split("@")[0]}`,
        mentions: [PLAYER_B],
      });
      encounterId = spawn.resultRefId;
      add(
        spawn.resultRefType === "ENCOUNTER" && encounterId !== null ? "PASS" : "BUG",
        "pve",
        "owner-admin",
        "spawn after no fishing encounter",
        spawn.outbound.map(textOf).join(" | ") || "no spawn output",
      );
    } else {
      add("PASS", "fishing", "player-b", "fishing encounter", `encounterId=${encounterId}`);
    }

    const start = await send({
      actor: OWNER_ADMIN,
      text: `/iniciarbatalha @${PLAYER_B.split("@")[0]}`,
      mentions: [PLAYER_B],
    });
    const captureBattleId = start.resultRefId;
    add(
      start.resultRefType === "BATTLE" && captureBattleId !== null ? "PASS" : "BUG",
      "pve",
      "owner-admin",
      "start capture battle",
      start.outbound.map(textOf).join(" | ") || "no battle start",
    );

    let captured = false;
    for (let attempt = 1; attempt <= 5 && !captured; attempt += 1) {
      const result = await send({ actor: PLAYER_B, text: "/capturar Poké Ball" });
      const captureText = result.outbound.map(textOf).join(" | ");
      if (/Pokémon capturado/iu.test(captureText)) {
        captured = true;
        add("PASS", "capture", "player-b", `capture attempt ${attempt}`, captureText);
      } else {
        add("INFO", "capture", "player-b", `capture attempt ${attempt}`, captureText || "no text");
      }
      if (!captured && captureBattleId !== null) {
        const status = await pool.query<{ status: string }>(
          "SELECT status FROM battles WHERE id=$1",
          [captureBattleId],
        );
        if (status.rows[0]?.status !== "ACTIVE") break;
      }
    }

    const captureAudit = await pool.query<{
      captured_count: string;
      caught_count: string;
      balls: string;
    }>(
      `SELECT
         (SELECT count(*)::text
          FROM pokemon_instances
          WHERE owner_player_id=$1 AND origin_type='CAPTURE') AS captured_count,
         (SELECT COALESCE(sum(caught_count),0)::text
          FROM player_pokedex_species
          WHERE player_id=$1) AS caught_count,
         COALESCE((
           SELECT balance.quantity::text
           FROM inventory_balances balance
           JOIN items item ON item.id=balance.item_id
           WHERE balance.player_id=$1 AND item.slug='poke-ball'
         ), '0') AS balls`,
      [playerBId],
    );
    add(
      captured && Number(captureAudit.rows[0]?.captured_count ?? "0") >= 1 ? "PASS" : "WARN",
      "capture",
      "player-b",
      "capture persistence",
      JSON.stringify(captureAudit.rows[0] ?? null),
    );

    if (!captured && captureBattleId !== null) {
      const battleStatus = await pool.query<{ status: string }>(
        "SELECT status FROM battles WHERE id=$1",
        [captureBattleId],
      );
      if (battleStatus.rows[0]?.status === "ACTIVE") {
        const flee = await send({ actor: PLAYER_B, text: "/fugir" });
        add(
          flee.outbound.some((entry) => /fuga|fugiu|terminou/iu.test(textOf(entry)))
            ? "PASS"
            : "BUG",
          "capture",
          "player-b",
          "close failed-capture battle",
          flee.outbound.map(textOf).join(" | ") || "no flee response",
        );
      }
    }

    // Visit the Center only after the encounter/battle lifecycle is closed.
    await send({ actor: PLAYER_B, text: scene("Centro Pokémon") });
    const center = await send({ actor: PLAYER_B, text: "/centropokemon" });
    add(
      center.outbound.some((entry) => /CENTRO POKÉMON|Centro Pokémon/iu.test(textOf(entry)))
        ? "PASS"
        : "BUG",
      "world-services",
      "player-b",
      "/centropokemon after narration",
      center.outbound.map(textOf).join(" | ") || "no center response",
    );

    const heal = await send({ actor: PLAYER_B, text: "/curar" });
    add(
      heal.outbound.some((entry) => /RECUPERAÇÃO CONCLUÍDA|HP restaurado/iu.test(textOf(entry)))
        ? "PASS"
        : "BUG",
      "pokemon-center",
      "player-b",
      "/curar",
      heal.outbound.map(textOf).join(" | ") || "no heal response",
    );

    const pc = await send({ actor: PLAYER_B, text: "/pc" });
    add(
      pc.outbound.some((entry) => /PC Pokémon|ARMAZENAMENTO|BOX/iu.test(textOf(entry)))
        ? "PASS"
        : "BUG",
      "pc",
      "player-b",
      "/pc",
      pc.outbound.map(textOf).join(" | ") || "no PC response",
    );

    const boxes = await send({ actor: PLAYER_B, text: "/caixas" });
    add(
      boxes.outbound.some((entry) => /CAIXAS|Caixa 01/iu.test(textOf(entry))) ? "PASS" : "BUG",
      "pc",
      "player-b",
      "/caixas",
      boxes.outbound.map(textOf).join(" | ") || "no box listing",
    );

    await send({ actor: PLAYER_B, text: "/sair" });

    // Automatic progression after a genuine WhatsApp battle win.
    const beforeProgress = await pool.query<{
      points: string;
      xp: string;
    }>(
      `SELECT
         (SELECT progression_points::text FROM trainer_progression WHERE player_id=$1) AS points,
         (SELECT COALESCE(sum(xp),0)::text FROM pokemon_instances WHERE owner_player_id=$1) AS xp`,
      [playerBId],
    );

    const rewardSpawn = await send({
      actor: OWNER_ADMIN,
      text: `/spawn @${PLAYER_B.split("@")[0]}`,
      mentions: [PLAYER_B],
    });
    if (rewardSpawn.resultRefType !== "ENCOUNTER") {
      add(
        "BUG",
        "progression",
        "owner-admin",
        "spawn reward battle",
        rewardSpawn.outbound.map(textOf).join(" | ") || "spawn failed",
      );
    }

    const rewardStart = await send({
      actor: OWNER_ADMIN,
      text: `/iniciarbatalha @${PLAYER_B.split("@")[0]}`,
      mentions: [PLAYER_B],
    });
    const rewardBattleId = rewardStart.resultRefId;
    if (rewardStart.resultRefType !== "BATTLE" || rewardBattleId === null) {
      add(
        "BUG",
        "progression",
        "owner-admin",
        "start reward battle",
        rewardStart.outbound.map(textOf).join(" | ") || "start failed",
      );
    }

    let rewardBattleStatus = "MISSING";
    let rewardMoveSlot = 1;
    if (rewardBattleId !== null) {
      const moveSnapshot = await pool.query<{ slot_no: number }>(
        `SELECT move.ordinality::int AS slot_no
         FROM battle_state_snapshots snapshot
         CROSS JOIN LATERAL jsonb_array_elements(snapshot.state->'sides') side
         CROSS JOIN LATERAL jsonb_array_elements(snapshot.state->'combatants') combatant
         CROSS JOIN LATERAL jsonb_array_elements(combatant->'moves') WITH ORDINALITY move(value, ordinality)
         WHERE snapshot.battle_id=$1
           AND snapshot.version=(
             SELECT MAX(version) FROM battle_state_snapshots WHERE battle_id=$1
           )
           AND side->>'controllerKind'='PLAYER'
           AND combatant->>'participantId'=side->>'activeParticipantId'
           AND combatant->>'participantKind'='PLAYER_POKEMON'
           AND COALESCE((move.value->>'power')::int,0)>0
         ORDER BY move.ordinality
         LIMIT 1`,
        [rewardBattleId],
      );
      rewardMoveSlot = moveSnapshot.rows[0]?.slot_no ?? 1;

      for (let turn = 1; turn <= 20; turn += 1) {
        const status = await pool.query<{ status: string }>(
          "SELECT status FROM battles WHERE id=$1",
          [rewardBattleId],
        );
        rewardBattleStatus = status.rows[0]?.status ?? "MISSING";
        if (rewardBattleStatus !== "ACTIVE") break;

        const current = await pool.query<{ state: unknown }>(
          `SELECT state
           FROM battle_state_snapshots
           WHERE battle_id=$1
           ORDER BY version DESC
           LIMIT 1`,
          [rewardBattleId],
        );
        const state = current.rows[0]?.state as
          | {
              sides?: Array<{
                controllerKind?: string;
                activeParticipantId?: string;
                participantIds?: string[];
              }>;
              combatants?: Array<{
                participantId?: string;
                currentHp?: number;
                moves?: Array<{ slotNo?: number; power?: number | null }>;
              }>;
            }
          | undefined;
        const playerSide = state?.sides?.find((side) => side.controllerKind === "PLAYER");
        const active = state?.combatants?.find(
          (combatant) => combatant.participantId === playerSide?.activeParticipantId,
        );

        if ((active?.currentHp ?? 0) <= 0) {
          const roster = (playerSide?.participantIds ?? [])
            .map((participantId) =>
              state?.combatants?.find((combatant) => combatant.participantId === participantId),
            )
            .filter(
              (
                combatant,
              ): combatant is NonNullable<NonNullable<typeof state>["combatants"]>[number] =>
                combatant !== undefined,
            );
          const reserveSlot =
            roster.findIndex(
              (combatant) =>
                combatant.participantId !== active?.participantId && (combatant.currentHp ?? 0) > 0,
            ) + 1;
          const hud = await send({ actor: PLAYER_B, text: "/batalha" });
          add(
            reserveSlot > 0 &&
              hud.outbound.some((entry) => /TROCA OBRIGATÓRIA/iu.test(textOf(entry)))
              ? "PASS"
              : "BUG",
            "battle",
            "player-b",
            "forced-switch HUD",
            hud.outbound.map(textOf).join(" | ") || "no forced-switch guidance",
          );
          if (reserveSlot <= 0) break;
          const switched = await send({
            actor: PLAYER_B,
            text: `/trocar ${reserveSlot}`,
          });
          add(
            switched.outbound.some((entry) => /entrou em campo/iu.test(textOf(entry)))
              ? "PASS"
              : "BUG",
            "battle",
            "player-b",
            `/trocar ${reserveSlot}`,
            switched.outbound.map(textOf).join(" | ") || "switch produced no feedback",
          );
          continue;
        }

        const damaging =
          active?.moves?.find((move) => typeof move.power === "number" && move.power > 0)?.slotNo ??
          rewardMoveSlot;
        const action = await send({
          actor: PLAYER_B,
          text: `/movimento ${damaging}`,
        });
        add(
          action.outbound.length > 0 ? "INFO" : "WARN",
          "battle",
          "player-b",
          `reward battle turn ${turn}`,
          action.outbound.map(textOf).join(" | ") || "no turn feedback",
        );
      }
      const final = await pool.query<{ status: string }>("SELECT status FROM battles WHERE id=$1", [
        rewardBattleId,
      ]);
      rewardBattleStatus = final.rows[0]?.status ?? "MISSING";
    }

    add(
      rewardBattleStatus === "WON" ? "PASS" : "WARN",
      "battle",
      "player-b",
      "play until terminal state",
      `status=${rewardBattleStatus}`,
    );

    await operational.runtime.flushOutbox();
    await sleep(1_000);

    const afterProgress = await pool.query<{
      points: string;
      xp: string;
      claims: string;
    }>(
      `SELECT
         (SELECT progression_points::text FROM trainer_progression WHERE player_id=$1) AS points,
         (SELECT COALESCE(sum(xp),0)::text FROM pokemon_instances WHERE owner_player_id=$1) AS xp,
         (SELECT count(*)::text FROM battle_reward_claims WHERE battle_id=$2) AS claims`,
      [playerBId, rewardBattleId],
    );

    const before = beforeProgress.rows[0];
    const after = afterProgress.rows[0];
    if (rewardBattleStatus === "WON") {
      const rewarded =
        BigInt(after?.points ?? "0") > BigInt(before?.points ?? "0") ||
        BigInt(after?.xp ?? "0") > BigInt(before?.xp ?? "0") ||
        Number(after?.claims ?? "0") > 0;
      add(
        rewarded ? "PASS" : "GAP",
        "progression",
        "player-b",
        "automatic reward after WhatsApp victory",
        JSON.stringify({ before, after, battleStatus: rewardBattleStatus }),
      );

      const rewardNotice = await pool.query<{
        status: string;
        destination_ref: string;
        text: string | null;
        internal_status: string | null;
      }>(
        `SELECT notice.status,
                notice.destination_ref,
                notice.payload->>'text' AS text,
                (
                  SELECT internal.status
                  FROM outbox_messages internal
                  WHERE internal.channel='INTERNAL'
                    AND internal.message_type='BATTLE_REWARD_RESULT'
                    AND internal.idempotency_key='progression.reward:' || $1::text
                ) AS internal_status
         FROM outbox_messages notice
         WHERE notice.idempotency_key='progression.reward-whatsapp:' || $1::text`,
        [rewardBattleId],
      );
      const rewardNoticeRow = rewardNotice.rows[0];
      add(
        rewardNoticeRow?.status === "SENT" &&
          rewardNoticeRow.destination_ref === WORLD &&
          rewardNoticeRow.internal_status === "SENT" &&
          /RECOMPENSA DE BATALHA/iu.test(rewardNoticeRow.text ?? "")
          ? "PASS"
          : "GAP",
        "progression",
        "player-b",
        "battle reward notification returns to battle chat",
        JSON.stringify(rewardNoticeRow ?? null),
      );
    }

    // PVP actual turn exchange, not only surrender.
    // Reunite A with B only if the persisted world state permits it naturally.
    const areas = await pool.query<{ player_id: string; slug: string }>(
      `SELECT location.player_id, area.slug
       FROM player_locations location
       JOIN areas area ON area.id=location.area_id
       WHERE location.player_id=ANY($1::uuid[])
       ORDER BY location.player_id`,
      [[playerAId, playerBId]],
    );
    add("INFO", "pvp", "system", "post-UAT player areas", JSON.stringify(areas.rows));

    const counts = findings.reduce(
      (acc, finding) => {
        acc[finding.severity] += 1;
        return acc;
      },
      { PASS: 0, INFO: 0, WARN: 0, BUG: 0, GAP: 0 },
    );
    console.log(JSON.stringify({ event: "sim.deep.complete", counts, findings }));
  } finally {
    await operational.runtime.stop().catch(() => {});
    await pool.end();
  }
}

await main();
