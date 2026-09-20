import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { SimulatedWhatsAppTranscriptEntry } from "../../src/adapters/whatsapp/simulated-whatsapp-adapter.js";
import { reconcileCanonicalAdminRegistry } from "../../src/platform/admin/postgres-admin-registry-seed.js";
import { withTransaction } from "../../src/platform/db/transaction.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import { SystemClock } from "../../src/platform/clock/index.js";
import { PvpService } from "../../src/modules/pvp/service.js";
import { PostgresPvpChallengeRepository } from "../../src/platform/pvp/postgres-pvp-challenge-repository.js";
import { PostgresPvpStartRepository } from "../../src/platform/pvp/postgres-pvp-start-repository.js";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const RECEPTION = "120363900000000001@g.us";
const WORLD = "120363900000000002@g.us";
const OWNER_ADMIN = "5599999999000@s.whatsapp.net";
const REVIEW_ADMIN = "5599999999002@s.whatsapp.net";
const ROGUE = "5599999999099@s.whatsapp.net";
const PLAYER_A = "5599999999101@s.whatsapp.net";
const PLAYER_B = "5599999999102@s.whatsapp.net";
const PLAYER_C = "5599999999103@s.whatsapp.net";

interface Finding {
  readonly severity: "PASS" | "INFO" | "WARN" | "BUG";
  readonly area: string;
  readonly actor: string;
  readonly action: string;
  readonly observation: string;
}

interface SendResult {
  readonly externalMessageId: string;
  readonly inboxStatus: string | null;
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
  readonly outbound: readonly Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>[];
}

const findings: Finding[] = [];
let sequence = 0;

function add(
  severity: Finding["severity"],
  area: string,
  actor: string,
  action: string,
  observation: string,
): void {
  findings.push({ severity, area, actor, action, observation });
  console.log(JSON.stringify({ event: "sim.uart.finding", severity, area, actor, action, observation }));
}

function textOf(entry: Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>): string {
  const payload = entry.message.payload;
  if (entry.message.messageType === "TEXT") {
    return typeof payload.text === "string" ? payload.text : "";
  }
  if (entry.message.messageType === "IMAGE") {
    return typeof payload.caption === "string" ? payload.caption : "";
  }
  return JSON.stringify(payload);
}

function actorName(ref: string): string {
  if (ref === OWNER_ADMIN) return "owner-admin";
  if (ref === REVIEW_ADMIN) return "review-admin";
  if (ref === ROGUE) return "rogue";
  if (ref === PLAYER_A) return "player-a";
  if (ref === PLAYER_B) return "player-b";
  if (ref === PLAYER_C) return "player-c";
  return ref;
}

async function ensureReviewAdmin(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client: PoolClient) => {
    await reconcileCanonicalAdminRegistry(client);
    const role = await client.query<{ id: string }>(
      "SELECT id FROM admin_roles WHERE slug='RECEPTION_MOD'",
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) throw new Error("RECEPTION_MOD role missing");

    const principal = await client.query<{ id: string }>(
      "SELECT id FROM admin_principals WHERE identity_ref=$1",
      [`whatsapp:${REVIEW_ADMIN}`],
    );
    const principalId = principal.rows[0]?.id ?? randomUUID();
    if (principal.rows[0] === undefined) {
      await client.query(
        "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1,$2,'ACTIVE')",
        [principalId, `whatsapp:${REVIEW_ADMIN}`],
      );
    }
    await client.query(
      "INSERT INTO admin_principal_roles(principal_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [principalId, roleId],
    );
    await client.query(
      `INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id)
       SELECT $1,$2,'GLOBAL',NULL
       WHERE NOT EXISTS (
         SELECT 1 FROM admin_principal_scopes
         WHERE principal_id=$2 AND scope_type='GLOBAL' AND scope_id IS NULL AND status='ACTIVE'
       )`,
      [randomUUID(), principalId],
    );
    const group = await client.query<{ id: string }>(
      "SELECT id FROM community_groups WHERE provider='baileys' AND chat_ref=$1",
      [RECEPTION],
    );
    const groupId = group.rows[0]?.id;
    if (groupId === undefined) throw new Error("Simulator reception group missing");
    await client.query(
      `INSERT INTO reception_staff_assignments(group_id,admin_principal_id,active)
       VALUES ($1,$2,TRUE)
       ON CONFLICT (group_id,admin_principal_id) DO UPDATE SET active=TRUE`,
      [groupId, principalId],
    );
  });
}

function fullFicha(name: string, starter: string, variant: string): string {
  return [
    `Nome: ${name}`,
    "Idade: 19",
    "Gênero / pronomes: ele/dele",
    `Aparência: Casaco de viagem, mochila leve e marcador ${variant}.`,
    `Personalidade: Curioso, prudente e competitivo; perfil ${variant}.`,
    `História / resumo: Saiu para explorar Zhoulia, registrar espécies e testar o sistema como ${variant}.`,
    `Pokémon inicial: ${starter}`,
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
    now: () => new Date("2026-09-20T00:30:00.000Z"),
  });

  const adapter = operational.adapter;
  let cursor = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const diagnosticError = (error: unknown): string => {
    if (!(error instanceof Error)) return String(error);
    const record = error as Error & {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
      table?: unknown;
    };
    return JSON.stringify({
      name: error.name,
      message: error.message,
      code: typeof record.code === "string" ? record.code : null,
      constraint: typeof record.constraint === "string" ? record.constraint : null,
      table: typeof record.table === "string" ? record.table : null,
      detail: typeof record.detail === "string" ? record.detail : null,
    });
  };

  const freshOutbound = (): readonly Extract<
    SimulatedWhatsAppTranscriptEntry,
    { direction: "OUTBOUND" }
  >[] => {
    const entries = adapter.transcript
      .slice(cursor)
      .filter(
        (
          entry,
        ): entry is Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }> =>
          entry.direction === "OUTBOUND",
      );
    cursor = adapter.transcript.length;
    return entries;
  };

  const send = async (input: {
    readonly actor: string;
    readonly chat: string;
    readonly text: string;
    readonly mentions?: readonly string[];
    readonly replyTo?: string | null;
    readonly externalMessageId?: string;
  }): Promise<SendResult> => {
    sequence += 1;
    const externalMessageId = input.externalMessageId ?? `SWARM-${String(sequence).padStart(5, "0")}`;
    cursor = adapter.transcript.length;
    try {
      await adapter.injectText({
        externalMessageId,
        senderRef: input.actor,
        chatRef: input.chat,
        text: input.text,
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
        replyToExternalMessageId: input.replyTo ?? null,
      });
      await operational.runtime.flushOutbox();
    } catch (error) {
      add(
        "BUG",
        "runtime",
        actorName(input.actor),
        input.text,
        `uncaught simulator/runtime exception: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      externalMessageId,
      inboxStatus: row?.status ?? null,
      resultRefType: row?.result_ref_type ?? null,
      resultRefId: row?.result_ref_id ?? null,
      outbound: freshOutbound(),
    };
  };

  const latestBot = (
    chat: string,
    predicate: (
      entry: Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>,
    ) => boolean = () => true,
  ) => {
    for (let index = adapter.transcript.length - 1; index >= 0; index -= 1) {
      const entry = adapter.transcript[index];
      if (
        entry !== undefined &&
        entry.direction === "OUTBOUND" &&
        entry.message.destinationRef === chat &&
        predicate(entry)
      ) {
        return entry;
      }
    }
    return null;
  };

  const replyLast = async (
    actor: string,
    chat: string,
    text: string,
  ): Promise<SendResult> => {
    const last = latestBot(chat);
    if (last === null) throw new Error(`No outbound message available for reply in ${chat}`);
    return send({ actor, chat, text, replyTo: last.providerExternalMessageId });
  };

  const join = async (actor: string): Promise<void> => {
    cursor = adapter.transcript.length;
    await adapter.injectMembership({ chatRef: RECEPTION, externalId: actor, action: "add" });
    await operational.runtime.flushOutbox();
    const out = freshOutbound();
    const welcome = out.find((entry) => /NOVO TREINADOR DETECTADO|BZZZT/u.test(textOf(entry)));
    add(
      welcome === undefined ? "BUG" : "PASS",
      "reception",
      actorName(actor),
      "membership add",
      welcome === undefined ? "welcome was not delivered" : "welcome image/caption delivered",
    );
  };

  const starters = await pool.query<{ display_name: string }>(
    `SELECT revision.display_name
     FROM content_release_pointers pointer
     JOIN starter_options option
       ON option.content_release_id=pointer.content_release_id AND option.active=TRUE
     JOIN pokemon_form_revisions revision
       ON revision.content_release_id=pointer.content_release_id
      AND revision.form_id=option.form_id
      AND revision.active=TRUE
     WHERE pointer.pointer_key='ACTIVE'
     ORDER BY option.sort_order,revision.display_name`,
  );
  if (starters.rows.length < 2) throw new Error("Swarm UAT requires at least two starter fixtures");
  const starterA = starters.rows[0]?.display_name;
  const starterB = starters.rows[1]?.display_name;
  if (starterA === undefined || starterB === undefined) throw new Error("Starter names unavailable");

  try {
    await ensureReviewAdmin(pool);
    await operational.runtime.start();
    cursor = adapter.transcript.length;

    add("INFO", "setup", "system", "start", `starters=${starters.rows.map((r) => r.display_name).join(", ")}`);

    // Player C intentionally behaves badly first.
    await join(PLAYER_C);
    const orphan = await send({ actor: PLAYER_C, chat: RECEPTION, text: "2" });
    add(
      orphan.outbound.length === 0 ? "PASS" : "WARN",
      "registration",
      "player-c",
      "freeform without active prompt",
      orphan.outbound.length === 0
        ? "ignored as expected"
        : `unexpected reply: ${orphan.outbound.map(textOf).join(" | ")}`,
    );
    await send({ actor: PLAYER_C, chat: RECEPTION, text: "/registrar" });
    const invalidMode = await replyLast(PLAYER_C, RECEPTION, "9");
    add(
      invalidMode.outbound.some((entry) => /1 ou 2|inválid|escolha/iu.test(textOf(entry)))
        ? "PASS"
        : "WARN",
      "registration",
      "player-c",
      "invalid mode 9",
      invalidMode.outbound.map(textOf).join(" | ") || "no visible feedback",
    );

    // Player A: full sheet, then admin requests changes, then second admin approves.
    await join(PLAYER_A);
    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/registrar" });
    await replyLast(PLAYER_A, RECEPTION, "2");
    await replyLast(PLAYER_A, RECEPTION, fullFicha("Ari Voss", starterA, "A"));
    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/confirmar" });
    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/confirmar sim" });

    const reviewA1 = latestBot(
      RECEPTION,
      (entry) => typeof entry.message.payload.registrationReview === "object",
    );
    if (reviewA1 === null) {
      add("BUG", "registration", "player-a", "submit", "no admin review notification");
    } else {
      const rogue = await send({
        actor: ROGUE,
        chat: RECEPTION,
        text: "/aprovar",
        replyTo: reviewA1.providerExternalMessageId,
      });
      add(
        rogue.outbound.some((entry) => /permiss|autoriz|administr/iu.test(textOf(entry)))
          ? "PASS"
          : "WARN",
        "authorization",
        "rogue",
        "approve player-a",
        rogue.outbound.map(textOf).join(" | ") || "no visible denial",
      );

      const adjust = await send({
        actor: OWNER_ADMIN,
        chat: RECEPTION,
        text: "/ajustes",
        replyTo: reviewA1.providerExternalMessageId,
      });
      add(
        adjust.outbound.some((entry) => /AJUSTES SOLICITADOS|devolvida/iu.test(textOf(entry)))
          ? "PASS"
          : "WARN",
        "admin-review",
        "owner-admin",
        "request changes player-a",
        adjust.outbound.map(textOf).join(" | ") || "no visible confirmation",
      );
    }

    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/editar" });
    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/modo completo" });
    await replyLast(
      PLAYER_A,
      RECEPTION,
      fullFicha("Ari Voss", starterA, "A-revisado"),
    );
    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/confirmar" });
    await send({ actor: PLAYER_A, chat: RECEPTION, text: "/confirmar sim" });

    const reviewA2 = latestBot(
      RECEPTION,
      (entry) => typeof entry.message.payload.registrationReview === "object",
    );
    if (reviewA2 === null) {
      add("BUG", "registration", "player-a", "resubmit", "second review notification missing");
    } else {
      const approved = await send({
        actor: REVIEW_ADMIN,
        chat: RECEPTION,
        text: "/aprovar",
        replyTo: reviewA2.providerExternalMessageId,
      });
      add(
        approved.outbound.some((entry) => /APROVAD|aprovad/iu.test(textOf(entry)))
          ? "PASS"
          : "WARN",
        "admin-review",
        "review-admin",
        "approve player-a",
        approved.outbound.map(textOf).join(" | ") || "no visible confirmation",
      );
    }

    // Player B: guided mode end-to-end.
    await join(PLAYER_B);
    await send({ actor: PLAYER_B, chat: RECEPTION, text: "/registrar" });
    await replyLast(PLAYER_B, RECEPTION, "1");
    for (const value of [
      "Bia Yun",
      "18",
      "ela/dela",
      "Cabelo curto, capa azul e mochila de campo.",
      "Paciente, observadora e competitiva.",
      "Quer mapear Zhoulia e compreender seus Pokémon selvagens.",
      starterB,
    ]) {
      await replyLast(PLAYER_B, RECEPTION, value);
    }
    await send({ actor: PLAYER_B, chat: RECEPTION, text: "/confirmar" });
    await send({ actor: PLAYER_B, chat: RECEPTION, text: "/confirmar sim" });

    const reviewB = latestBot(
      RECEPTION,
      (entry) => {
        const review = entry.message.payload.registrationReview;
        return typeof review === "object" && entry !== reviewA2;
      },
    );
    if (reviewB === null) {
      add("BUG", "registration", "player-b", "guided submit", "review notification missing");
    } else {
      await send({
        actor: OWNER_ADMIN,
        chat: RECEPTION,
        text: "/aprovar",
        replyTo: reviewB.providerExternalMessageId,
      });
    }

    // Let provisioning/announcements settle.
    await operational.runtime.flushOutbox();
    await sleep(150);

    const readiness = await pool.query<{
      external_id: string;
      access_status: string | null;
      onboarding_state: string | null;
      area_slug: string | null;
      team_count: number;
      pokedollars: string;
      poke_balls: string;
    }>(
      `SELECT identity.external_id,
              access.status AS access_status,
              onboarding.state AS onboarding_state,
              area.slug AS area_slug,
              (
                SELECT count(*)::integer
                FROM pokemon_roster_slots roster
                WHERE roster.player_id=player.id AND roster.placement_kind='TEAM'
              ) AS team_count,
              COALESCE((
                SELECT balance.amount::text
                FROM wallet_balances balance
                JOIN currency_definitions currency ON currency.id=balance.currency_id
                WHERE balance.player_id=player.id AND currency.slug='pokedollar'
              ), '0') AS pokedollars,
              COALESCE((
                SELECT balance.quantity::text
                FROM inventory_balances balance
                JOIN items item ON item.id=balance.item_id
                WHERE balance.player_id=player.id AND item.slug='poke-ball'
              ), '0') AS poke_balls
       FROM player_identities identity
       JOIN players player ON player.id=identity.player_id
       LEFT JOIN player_access access ON access.player_id=player.id
       LEFT JOIN onboarding_states onboarding ON onboarding.player_id=player.id
       LEFT JOIN player_locations location ON location.player_id=player.id
       LEFT JOIN areas area ON area.id=location.area_id
       WHERE identity.provider='baileys'
         AND identity.external_id = ANY($1::text[])
       ORDER BY identity.external_id`,
      [[PLAYER_A, PLAYER_B, PLAYER_C]],
    );

    for (const row of readiness.rows) {
      const expectedApproved = row.external_id === PLAYER_A || row.external_id === PLAYER_B;
      const ready =
        row.access_status === "ACTIVE" &&
        row.onboarding_state === "COMPLETE" &&
        row.area_slug === "vila-dos-arrozais" &&
        row.team_count >= 1 &&
        row.pokedollars === "2000" &&
        row.poke_balls === "5";
      add(
        expectedApproved ? (ready ? "PASS" : "BUG") : "INFO",
        "provisioning",
        actorName(row.external_id),
        "readiness",
        JSON.stringify(row),
      );
    }

    // World read UX and service discovery.
    for (const player of [PLAYER_A, PLAYER_B]) {
      for (const command of ["/menu", "/perfil", "/equipe", "/inventario", "/pokedex", "/onde"]) {
        const result = await send({ actor: player, chat: WORLD, text: command });
        add(
          result.outbound.length > 0 ? "PASS" : "BUG",
          "world-ux",
          actorName(player),
          command,
          result.outbound.map(textOf).join(" | ") || "no response",
        );
      }
    }

    // PVP: same-area challenge, accept, one status read, then surrender.
    const challenge = await send({
      actor: PLAYER_A,
      chat: WORLD,
      text: `/desafiar @${PLAYER_B.split("@")[0]}`,
      mentions: [PLAYER_B],
    });
    add(
      challenge.outbound.some((entry) => /desafiou|aceitar/iu.test(textOf(entry))) ? "PASS" : "BUG",
      "pvp",
      "player-a",
      "challenge player-b",
      challenge.outbound.map(textOf).join(" | ") || "no challenge response",
    );
    const accepted = await send({ actor: PLAYER_B, chat: WORLD, text: "/aceitar" });
    add(
      accepted.resultRefType === "PVP" && accepted.resultRefId !== null ? "PASS" : "BUG",
      "pvp",
      "player-b",
      "accept",
      accepted.outbound.map(textOf).join(" | ") || "no accept response",
    );

    if (accepted.inboxStatus === "FAILED") {
      const target = await pool.query<{ player_id: string }>(
        "SELECT player_id FROM player_identities WHERE provider='baileys' AND external_id=$1",
        [PLAYER_B],
      );
      const targetPlayerId = target.rows[0]?.player_id;
      const challengeRow = await pool.query<{
        id: string;
        status: string;
        encounter_id: string | null;
        battle_id: string | null;
        revision: string;
      }>(
        `SELECT id,status,encounter_id,battle_id,revision::text
         FROM pvp_challenges
         WHERE target_player_id=$1
         ORDER BY created_at DESC
         LIMIT 1`,
        [targetPlayerId],
      );
      const currentChallenge = challengeRow.rows[0];
      add(
        "INFO",
        "pvp-diagnostic",
        "system",
        "state after runtime /aceitar",
        JSON.stringify(currentChallenge ?? null),
      );

      if (targetPlayerId !== undefined && currentChallenge !== undefined) {
        const seedProvider = new AesEncounterSeedProvider(key, 1);
        const challenges = new PostgresPvpChallengeRepository(pool);
        const diagnosticPvp = new PvpService(
          challenges,
          seedProvider,
          new SystemClock(),
          { enabled: true, reason: null },
          { challengeTtlMs: 120_000, turnWindowTtlMs: 120_000 },
          new PostgresPvpStartRepository(pool, seedProvider),
        );
        try {
          const diagnosticAccept = await diagnosticPvp.acceptChallenge({
            challengeId: currentChallenge.id,
            actorPlayerId: targetPlayerId,
          });
          add(
            diagnosticAccept.ok ? "INFO" : "BUG",
            "pvp-diagnostic",
            "system",
            "direct accept replay",
            diagnosticAccept.ok
              ? JSON.stringify({
                  status: diagnosticAccept.value.challenge.status,
                  encounterId: diagnosticAccept.value.encounterId,
                  replayed: diagnosticAccept.value.replayed,
                })
              : JSON.stringify(diagnosticAccept.error),
          );
        } catch (error) {
          add(
            "BUG",
            "pvp-diagnostic",
            "system",
            "direct accept exception",
            diagnosticError(error),
          );
        }

        try {
          const diagnosticStart = await diagnosticPvp.startEncounter({
            challengeId: currentChallenge.id,
            actorPlayerId: targetPlayerId,
          });
          add(
            diagnosticStart.ok ? "INFO" : "BUG",
            "pvp-diagnostic",
            "system",
            "direct start",
            diagnosticStart.ok ? JSON.stringify(diagnosticStart.value) : JSON.stringify(diagnosticStart.error),
          );
        } catch (error) {
          add(
            "BUG",
            "pvp-diagnostic",
            "system",
            "direct start exception",
            diagnosticError(error),
          );
        }
      }
    }

    await send({ actor: PLAYER_A, chat: WORLD, text: "/batalha" });
    const surrender = await send({ actor: PLAYER_B, chat: WORLD, text: "/desistir" });
    add(
      surrender.outbound.some((entry) => /desistiu|venceu/iu.test(textOf(entry))) ? "PASS" : "WARN",
      "pvp",
      "player-b",
      "surrender",
      surrender.outbound.map(textOf).join(" | ") || "no surrender response",
    );

    // Narrator/admin-driven PVE.
    const spawn = await send({
      actor: OWNER_ADMIN,
      chat: WORLD,
      text: `/spawn @${PLAYER_A.split("@")[0]}`,
      mentions: [PLAYER_A],
    });
    add(
      spawn.resultRefType === "ENCOUNTER" && spawn.resultRefId !== null ? "PASS" : "BUG",
      "pve",
      "owner-admin",
      "spawn player-a",
      spawn.outbound.map(textOf).join(" | ") || "no spawn response",
    );
    const battleStart = await send({
      actor: OWNER_ADMIN,
      chat: WORLD,
      text: `/iniciarbatalha @${PLAYER_A.split("@")[0]}`,
      mentions: [PLAYER_A],
    });
    add(
      battleStart.resultRefType === "BATTLE" && battleStart.resultRefId !== null ? "PASS" : "BUG",
      "pve",
      "owner-admin",
      "start battle player-a",
      battleStart.outbound.map(textOf).join(" | ") || "no battle-start response",
    );

    const battleView = await send({ actor: PLAYER_A, chat: WORLD, text: "/batalha" });
    add(
      battleView.outbound.some((entry) => /BATALHA|Turno/iu.test(textOf(entry))) ? "PASS" : "BUG",
      "pve",
      "player-a",
      "/batalha",
      battleView.outbound.map(textOf).join(" | ") || "no battle HUD",
    );

    const capture = await send({ actor: PLAYER_A, chat: WORLD, text: "/capturar" });
    const captureText = capture.outbound.map(textOf).join(" | ");
    add(
      /capturad|Poké Ball|bola|captura/iu.test(captureText) ? "INFO" : "WARN",
      "capture",
      "player-a",
      "/capturar",
      captureText || "no capture response",
    );

    const move = await send({ actor: PLAYER_A, chat: WORLD, text: "/movimento 1" });
    add(
      move.outbound.length > 0 ? "PASS" : "WARN",
      "battle",
      "player-a",
      "/movimento 1",
      move.outbound.map(textOf).join(" | ") || "no move feedback",
    );

    if (battleStart.resultRefId !== null) {
      const status = await pool.query<{ status: string }>(
        "SELECT status FROM battles WHERE id=$1",
        [battleStart.resultRefId],
      );
      const battleStatus = status.rows[0]?.status ?? "MISSING";
      add("INFO", "battle", "system", "post-turn status", battleStatus);
      if (["ACTIVE", "RESOLVING_TURN"].includes(battleStatus)) {
        const flee = await send({ actor: PLAYER_A, chat: WORLD, text: "/fugir" });
        add(
          flee.outbound.some((entry) => /fugiu|terminou/iu.test(textOf(entry))) ? "PASS" : "WARN",
          "pve",
          "player-a",
          "/fugir",
          flee.outbound.map(textOf).join(" | ") || "no flee response",
        );
      }
    }

    // Travel after combat.
    const where = await send({ actor: PLAYER_A, chat: WORLD, text: "/onde" });
    const whereText = where.outbound.map(textOf).join("\n");
    const routeMatch = /→ `\/ir (\d+)`/u.exec(whereText);
    if (routeMatch?.[1] === undefined) {
      add("WARN", "world", "player-a", "travel discovery", `no available route parsed: ${whereText}`);
    } else {
      const travel = await send({
        actor: PLAYER_A,
        chat: WORLD,
        text: `/ir ${routeMatch[1]}`,
      });
      add(
        travel.outbound.length > 0 ? "PASS" : "BUG",
        "world",
        "player-a",
        `/ir ${routeMatch[1]}`,
        travel.outbound.map(textOf).join(" | ") || "no travel response",
      );
    }

    // World services from current state: test discoverability and blocking.
    for (const command of ["/pokemart", "/centropokemon", "/pc", "/pescar"]) {
      const result = await send({ actor: PLAYER_B, chat: WORLD, text: command });
      add(
        result.outbound.length > 0 ? "INFO" : "WARN",
        "world-services",
        "player-b",
        command,
        result.outbound.map(textOf).join(" | ") || "no response",
      );
    }

    // Duplicate exact message id: should replay, not duplicate domain effects.
    const duplicateId = "SWARM-DUPLICATE-ONE";
    const first = await send({
      actor: PLAYER_A,
      chat: WORLD,
      text: "/perfil",
      externalMessageId: duplicateId,
    });
    const second = await send({
      actor: PLAYER_A,
      chat: WORLD,
      text: "/perfil",
      externalMessageId: duplicateId,
    });
    add(
      second.inboxStatus === "PROCESSED" || second.inboxStatus === "REPLAYED"
        ? "PASS"
        : "WARN",
      "idempotency",
      "player-a",
      "duplicate /perfil",
      `first=${first.inboxStatus}, second=${second.inboxStatus}`,
    );

    const counts = findings.reduce(
      (acc, finding) => {
        acc[finding.severity] += 1;
        return acc;
      },
      { PASS: 0, INFO: 0, WARN: 0, BUG: 0 },
    );

    console.log(
      JSON.stringify({
        event: "sim.uat.complete",
        actors: {
          players: [PLAYER_A, PLAYER_B, PLAYER_C],
          admins: [OWNER_ADMIN, REVIEW_ADMIN],
          unauthorized: ROGUE,
        },
        counts,
        findings,
      }),
    );

    // Product findings do not fail the proof. Only infrastructure/unhandled harness failures do.
  } finally {
    await operational.runtime.stop().catch(() => {});
    await pool.end();
  }
}

await main();
