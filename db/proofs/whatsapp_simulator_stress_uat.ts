import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { SimulatedWhatsAppTranscriptEntry } from "../../src/adapters/whatsapp/simulated-whatsapp-adapter.js";
import { reconcileCanonicalAdminRegistry } from "../../src/platform/admin/postgres-admin-registry-seed.js";
import { withTransaction } from "../../src/platform/db/transaction.js";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const RECEPTION = "120363900000000101@g.us";
const WORLD = "120363900000000102@g.us";
const OWNER_ADMINS = [
  "5599999999300@s.whatsapp.net",
  "5599999999301@s.whatsapp.net",
  "5599999999302@s.whatsapp.net",
] as const;
const ROGUE = "5599999999399@s.whatsapp.net";
const PLAYERS = Array.from(
  { length: 12 },
  (_, index) => `55999999994${String(index + 1).padStart(2, "0")}@s.whatsapp.net`,
);

interface Finding {
  readonly severity: "PASS" | "INFO" | "WARN" | "BUG";
  readonly area: string;
  readonly action: string;
  readonly observation: string;
}

interface SendResult {
  readonly externalMessageId: string;
  readonly inboxStatus: string | null;
  readonly outbound: readonly Extract<
    SimulatedWhatsAppTranscriptEntry,
    { direction: "OUTBOUND" }
  >[];
}

const findings: Finding[] = [];
let sequence = 20_000;

function add(
  severity: Finding["severity"],
  area: string,
  action: string,
  observation: string,
): void {
  findings.push({ severity, area, action, observation });
  console.log(
    JSON.stringify({
      event: "sim.stress.finding",
      severity,
      area,
      action,
      observation,
    }),
  );
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

function firstOutbound(
  entries: readonly Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>[],
): Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }> {
  const entry = entries[0];
  if (entry === undefined) throw new Error("Expected simulator outbound message");
  return entry;
}

async function ensurePrincipal(
  client: PoolClient,
  ownerRoleId: string,
  externalId: string,
): Promise<string> {
  const identityRef = `whatsapp:${externalId}`;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM admin_principals WHERE identity_ref=$1",
    [identityRef],
  );
  const principalId = existing.rows[0]?.id ?? randomUUID();
  if (existing.rows[0] === undefined) {
    await client.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1,$2,'ACTIVE')",
      [principalId, identityRef],
    );
  }
  await client.query(
    "INSERT INTO admin_principal_roles(principal_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [principalId, ownerRoleId],
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
  return principalId;
}

async function ensureGroup(
  client: PoolClient,
  input: {
    readonly chatRef: string;
    readonly role: "RECEPTION" | "GAME";
    readonly displayName: string;
    readonly capabilities: readonly string[];
  },
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM community_groups WHERE provider='baileys' AND chat_ref=$1",
    [input.chatRef],
  );
  const groupId = existing.rows[0]?.id ?? randomUUID();
  if (existing.rows[0] === undefined) {
    await client.query(
      `INSERT INTO community_groups(id,provider,chat_ref,role,display_name,status)
       VALUES ($1,'baileys',$2,$3,$4,'ACTIVE')`,
      [groupId, input.chatRef, input.role, input.displayName],
    );
  }
  for (const capability of input.capabilities) {
    await client.query(
      `INSERT INTO community_group_capabilities(group_id,capability_key,active)
       VALUES ($1,$2,TRUE)
       ON CONFLICT (group_id,capability_key) DO UPDATE SET active=TRUE`,
      [groupId, capability],
    );
  }
  return groupId;
}

async function setup(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const registry = await reconcileCanonicalAdminRegistry(client);
    const receptionGroupId = await ensureGroup(client, {
      chatRef: RECEPTION,
      role: "RECEPTION",
      displayName: "Recepcao Stress",
      capabilities: ["admin.review", "onboarding", "player.basic", "pve", "pvp", "world"],
    });
    await ensureGroup(client, {
      chatRef: WORLD,
      role: "GAME",
      displayName: "Mundo Stress",
      capabilities: ["player.basic", "pve", "pvp", "world"],
    });

    for (const externalId of OWNER_ADMINS) {
      const principalId = await ensurePrincipal(client, registry.ownerRoleId, externalId);
      await client.query(
        `INSERT INTO reception_staff_assignments(group_id,admin_principal_id,active)
         VALUES ($1,$2,TRUE)
         ON CONFLICT (group_id,admin_principal_id) DO UPDATE SET active=TRUE`,
        [receptionGroupId, principalId],
      );
    }
  });
}

function fullFicha(index: number, starter: string): string {
  return [
    `Nome: Stress ${String(index + 1).padStart(2, "0")}`,
    `Idade: ${18 + (index % 7)}`,
    index % 2 === 0 ? "Gênero / pronomes: ele/dele" : "Gênero / pronomes: ela/dela",
    `Aparência: Viajante de Zhoulia número ${index + 1}, mochila e roupa de campo.`,
    `Personalidade: ${index % 3 === 0 ? "Impulsivo" : "Observador"}, curioso e cooperativo.`,
    `História / resumo: Entrou no RPG para explorar Zhoulia no cenário de stress ${index + 1}.`,
    `Pokémon inicial: ${starter}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await setup(pool);

  const key = Buffer.alloc(32, 19);
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
    readonly chat: string;
    readonly text: string;
    readonly mentions?: readonly string[];
    readonly replyTo?: string | null;
    readonly externalMessageId?: string;
  }): Promise<SendResult> => {
    sequence += 1;
    const externalMessageId = input.externalMessageId ?? `STRESS-${sequence}`;
    cursor = adapter.transcript.length;
    await adapter.injectText({
      externalMessageId,
      senderRef: input.actor,
      chatRef: input.chat,
      text: input.text,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
      replyToExternalMessageId: input.replyTo ?? null,
    });
    await operational.runtime.flushOutbox();
    const inbox = await pool.query<{ status: string }>(
      `SELECT status FROM inbox_messages
       WHERE provider='baileys' AND external_message_id=$1`,
      [externalMessageId],
    );
    return {
      externalMessageId,
      inboxStatus: inbox.rows[0]?.status ?? null,
      outbound: newOutbound(),
    };
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
  const starterNames = starters.rows.map((row) => row.display_name);
  if (starterNames.length === 0) throw new Error("No starter fixture is available");

  try {
    await operational.runtime.start();
    cursor = adapter.transcript.length;

    for (const player of PLAYERS) {
      await adapter.injectMembership({ chatRef: RECEPTION, externalId: player, action: "add" });
    }
    await operational.runtime.flushOutbox();
    add("PASS", "reception", "12 concurrent membership adds", `players=${PLAYERS.length}`);

    for (let index = 0; index < PLAYERS.length; index += 1) {
      const player = PLAYERS[index];
      if (player === undefined) continue;
      const mode = await send({ actor: player, chat: RECEPTION, text: "/registrar" });
      const modePrompt = firstOutbound(mode.outbound);
      const fullMode = await send({
        actor: player,
        chat: RECEPTION,
        text: "2",
        replyTo: modePrompt.providerExternalMessageId,
      });
      const formPrompt = firstOutbound(fullMode.outbound);
      const starter = starterNames[index % starterNames.length];
      if (starter === undefined) throw new Error("Starter fixture index failed");
      await send({
        actor: player,
        chat: RECEPTION,
        text: fullFicha(index, starter),
        replyTo: formPrompt.providerExternalMessageId,
      });
      await send({ actor: player, chat: RECEPTION, text: "/confirmar" });
      const submitted = await send({
        actor: player,
        chat: RECEPTION,
        text: "/confirmar sim",
      });
      const review = submitted.outbound.find(
        (entry) => typeof entry.message.payload.registrationReview === "object",
      );
      if (review === undefined) {
        add("BUG", "registration", `submit player ${index + 1}`, "review notification missing");
        continue;
      }
      const admin = OWNER_ADMINS[index % OWNER_ADMINS.length];
      if (admin === undefined) throw new Error("Admin fixture index failed");
      const approval = await send({
        actor: admin,
        chat: RECEPTION,
        text: "/aprovar",
        replyTo: review.providerExternalMessageId,
      });
      add(
        approval.outbound.some((entry) =>
          /APROVAÇÃO REGISTRADA|TRAINER STATUS: ACTIVE/iu.test(textOf(entry)),
        )
          ? "PASS"
          : "BUG",
        "registration",
        `approve player ${index + 1}`,
        approval.outbound.map(textOf).join(" | ") || "no approval output",
      );
    }

    await operational.runtime.flushOutbox();

    const readiness = await pool.query<{
      external_id: string;
      status: string | null;
      onboarding: string | null;
      area: string | null;
      money: string;
      balls: string;
      team: number;
    }>(
      `SELECT identity.external_id,
              access.status,
              onboarding.state AS onboarding,
              area.slug AS area,
              COALESCE((
                SELECT balance.amount::text
                FROM wallet_balances balance
                JOIN currency_definitions currency ON currency.id=balance.currency_id
                WHERE balance.player_id=player.id AND currency.slug='pokedollar'
              ), '0') AS money,
              COALESCE((
                SELECT balance.quantity::text
                FROM inventory_balances balance
                JOIN items item ON item.id=balance.item_id
                WHERE balance.player_id=player.id AND item.slug='poke-ball'
              ), '0') AS balls,
              (
                SELECT count(*)::integer
                FROM pokemon_roster_slots roster
                WHERE roster.player_id=player.id AND roster.placement_kind='TEAM'
              ) AS team
       FROM player_identities identity
       JOIN players player ON player.id=identity.player_id
       LEFT JOIN player_access access ON access.player_id=player.id
       LEFT JOIN onboarding_states onboarding ON onboarding.player_id=player.id
       LEFT JOIN player_locations location ON location.player_id=player.id
       LEFT JOIN areas area ON area.id=location.area_id
       WHERE identity.provider='baileys'
         AND identity.external_id=ANY($1::text[])
       ORDER BY identity.external_id`,
      [PLAYERS],
    );
    const badReadiness = readiness.rows.filter(
      (row) =>
        row.status !== "ACTIVE" ||
        row.onboarding !== "COMPLETE" ||
        row.area !== "vila-dos-arrozais" ||
        row.money !== "2000" ||
        row.balls !== "5" ||
        row.team !== 1,
    );
    add(
      badReadiness.length === 0 ? "PASS" : "BUG",
      "provisioning",
      "12-player readiness",
      badReadiness.length === 0 ? "all exact" : JSON.stringify(badReadiness),
    );

    const burstIds = PLAYERS.map((player, index) => ({
      player,
      id: `STRESS-BURST-${index + 1}`,
    }));
    await Promise.all(
      burstIds.map(({ player, id }) =>
        adapter.injectText({
          externalMessageId: id,
          senderRef: player,
          chatRef: WORLD,
          text: "/perfil",
        }),
      ),
    );
    await operational.runtime.flushOutbox();
    const burst = await pool.query<{ status: string; count: string }>(
      `SELECT status,count(*)::text AS count
       FROM inbox_messages
       WHERE external_message_id=ANY($1::text[])
       GROUP BY status
       ORDER BY status`,
      [burstIds.map((entry) => entry.id)],
    );
    add(
      burst.rows.length === 1 &&
        burst.rows[0]?.status === "PROCESSED" &&
        burst.rows[0]?.count === String(PLAYERS.length)
        ? "PASS"
        : "BUG",
      "concurrency",
      "12 simultaneous /perfil",
      JSON.stringify(burst.rows),
    );

    const rogue = await send({
      actor: ROGUE,
      chat: WORLD,
      text: `/spawn @${PLAYERS[0]?.split("@")[0]}`,
      mentions: PLAYERS[0] === undefined ? [] : [PLAYERS[0]],
    });
    add(
      rogue.outbound.some((entry) => /não pode|bloquead|autoriz/iu.test(textOf(entry)))
        ? "PASS"
        : "WARN",
      "authorization",
      "non-admin /spawn",
      rogue.outbound.map(textOf).join(" | ") || "no visible denial",
    );

    for (let pair = 0; pair < 6; pair += 1) {
      const challenger = PLAYERS[pair * 2];
      const target = PLAYERS[pair * 2 + 1];
      if (challenger === undefined || target === undefined) continue;
      const challenge = await send({
        actor: challenger,
        chat: WORLD,
        text: `/desafiar @${target.split("@")[0]}`,
        mentions: [target],
      });
      if (!challenge.outbound.some((entry) => /desafiou|aceitar/iu.test(textOf(entry)))) {
        add("BUG", "pvp", `challenge pair ${pair + 1}`, challenge.outbound.map(textOf).join(" | "));
        continue;
      }
      const accepted = await send({ actor: target, chat: WORLD, text: "/aceitar" });
      add(
        accepted.outbound.some((entry) => /Batalha iniciada/iu.test(textOf(entry)))
          ? "PASS"
          : "BUG",
        "pvp",
        `accept pair ${pair + 1}`,
        accepted.outbound.map(textOf).join(" | "),
      );
      await send({ actor: target, chat: WORLD, text: "/desistir" });
    }

    adapter.failNext(1);
    const deliveryProbe = await send({
      actor: PLAYERS[0] ?? "",
      chat: WORLD,
      text: "/perfil",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await operational.runtime.flushOutbox();
    const retried = await pool.query<{ status: string; attempts: number }>(
      `SELECT status,attempts
       FROM outbox_messages
       WHERE causation_id=(
         SELECT id FROM inbox_messages
         WHERE provider='baileys' AND external_message_id=$1
       )
       ORDER BY created_at DESC
       LIMIT 1`,
      [deliveryProbe.externalMessageId],
    );
    add(
      retried.rows[0]?.status === "SENT" && (retried.rows[0]?.attempts ?? 0) >= 2 ? "PASS" : "BUG",
      "delivery",
      "one forced send failure then retry",
      JSON.stringify(retried.rows[0] ?? null),
    );

    await adapter.setConnected(false);
    let disconnectedRejected = false;
    try {
      await adapter.injectText({
        senderRef: PLAYERS[1] ?? "",
        chatRef: WORLD,
        text: "/perfil",
      });
    } catch {
      disconnectedRejected = true;
    }
    await adapter.setConnected(true);
    const reconnect = await send({
      actor: PLAYERS[1] ?? "",
      chat: WORLD,
      text: "/perfil",
    });
    add(
      disconnectedRejected && reconnect.inboxStatus === "PROCESSED" ? "PASS" : "BUG",
      "transport",
      "disconnect/reconnect",
      `disconnectedRejected=${disconnectedRejected}, reconnect=${reconnect.inboxStatus}`,
    );

    const spammer = PLAYERS[2];
    if (spammer !== undefined) {
      const spammerPlayer = await pool.query<{ player_id: string }>(
        `SELECT player_id
         FROM player_identities
         WHERE provider='baileys' AND external_id=$1 AND status='ACTIVE'`,
        [spammer],
      );
      const spammerPlayerId = spammerPlayer.rows[0]?.player_id;
      if (spammerPlayerId === undefined) throw new Error("Spammer player identity is missing");
      const subjectHash = createHash("sha256")
        .update(`player:${spammerPlayerId}`)
        .digest("hex");
      const beforeBucket = await pool.query<{ used: number }>(
        `SELECT used
         FROM messaging_rate_limit_buckets
         WHERE scope_kind='PLAYER'
           AND subject_hash=$1
           AND policy_key='messaging.player.v1'`,
        [subjectHash],
      );
      const usedBeforeSpam = beforeBucket.rows[0]?.used ?? 0;
      const expectedRateLimited = Math.max(0, 25 - Math.max(0, 20 - usedBeforeSpam));

      const spamIds: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const id = `STRESS-SPAM-${index + 1}`;
        spamIds.push(id);
        await adapter.injectText({
          externalMessageId: id,
          senderRef: spammer,
          chatRef: WORLD,
          text: "/perfil",
        });
      }
      await operational.runtime.flushOutbox();
      const spam = await pool.query<{ status: string; count: string }>(
        `SELECT status,count(*)::text AS count
         FROM inbox_messages
         WHERE external_message_id=ANY($1::text[])
         GROUP BY status
         ORDER BY status`,
        [spamIds],
      );
      const limited = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM outbox_messages outgoing
         JOIN inbox_messages incoming ON incoming.id=outgoing.causation_id
         WHERE incoming.external_message_id=ANY($1::text[])
           AND outgoing.idempotency_key LIKE 'messaging.error:%:RATE_LIMITED'`,
        [spamIds],
      );
      add(
        Number(limited.rows[0]?.count ?? "0") === expectedRateLimited ? "PASS" : "BUG",
        "rate-limit",
        "25-message single-player burst",
        JSON.stringify({
          inbox: spam.rows,
          rateLimited: limited.rows[0]?.count ?? "0",
          usedBeforeSpam,
          expectedRateLimited,
        }),
      );
    }

    const duplicateId = "STRESS-DUPLICATE-ID";
    const duplicatePlayer = PLAYERS[3];
    if (duplicatePlayer !== undefined) {
      await adapter.injectText({
        externalMessageId: duplicateId,
        senderRef: duplicatePlayer,
        chatRef: WORLD,
        text: "/onde",
      });
      await operational.runtime.flushOutbox();
      await adapter.injectText({
        externalMessageId: duplicateId,
        senderRef: duplicatePlayer,
        chatRef: WORLD,
        text: "/onde",
      });
      await operational.runtime.flushOutbox();
      const duplicate = await pool.query<{ rows: string }>(
        `SELECT count(*)::text AS rows
         FROM inbox_messages
         WHERE provider='baileys' AND external_message_id=$1`,
        [duplicateId],
      );
      add(
        duplicate.rows[0]?.rows === "1" ? "PASS" : "BUG",
        "idempotency",
        "duplicate exact provider id",
        JSON.stringify(duplicate.rows[0] ?? null),
      );
    }

    const counts = findings.reduce(
      (acc, finding) => {
        acc[finding.severity] += 1;
        return acc;
      },
      { PASS: 0, INFO: 0, WARN: 0, BUG: 0 },
    );
    console.log(JSON.stringify({ event: "sim.stress.complete", counts, findings }));
  } finally {
    await operational.runtime.stop().catch(() => {});
    await pool.end();
  }
}

await main();
