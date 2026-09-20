import { createHash } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Pool } from "pg";
import type {
  SimulatedWhatsAppAdapter,
  SimulatedWhatsAppTranscriptEntry,
} from "../../src/adapters/whatsapp/simulated-whatsapp-adapter.js";
import { loadConfig } from "../../src/platform/config/env.js";
import { closeDatabasePool, createDatabasePool } from "../../src/platform/db/database.js";
import { assertDatabaseSchemaCurrent } from "../../src/platform/db/migrations.js";
import type { PveBattleRuntimeConfig } from "../../src/runtime/compose-pve-battle-runtime.js";
import {
  createOperationalSimulatedWhatsAppRuntime,
  type OperationalSimulatedWhatsAppRuntime,
} from "../../src/runtime/compose-simulated-whatsapp-runtime.js";
import type { EncounterRngRuntimeConfig } from "../../src/runtime/encounter-rng-runtime-config.js";
import { loadWorldServiceMediaRuntimeConfig } from "../../src/runtime/world-service-media-runtime-config.js";

interface ListedGroup {
  readonly chatRef: string;
  readonly role: string;
  readonly displayName: string;
}

interface ListedActor {
  readonly ref: string;
  readonly kind: "PLAYER" | "ADMIN";
  readonly label: string;
}

const SIMULATOR_KEY = createHash("sha256")
  .update("pokemon-rpg:whatsapp-simulator:v1", "utf8")
  .digest();

function simulatorRngConfig(): EncounterRngRuntimeConfig {
  return {
    encryptionKey: SIMULATOR_KEY,
    encryptionKeyVersion: 1,
  };
}

function simulatorPveConfig(rng: EncounterRngRuntimeConfig): PveBattleRuntimeConfig {
  return {
    turnWindowTtlMs: 120_000,
    maintenanceBatchSize: 50,
    encryptionKeys: new Map([[rng.encryptionKeyVersion, rng.encryptionKey]]),
  };
}

function normalizeActorRef(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `${trimmed}@s.whatsapp.net`;
  return trimmed;
}

function shortRef(value: string | null): string {
  if (value === null || value.length === 0) return "?";
  const at = value.indexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

function renderOutbound(
  entry: Extract<SimulatedWhatsAppTranscriptEntry, { direction: "OUTBOUND" }>,
): string {
  const payload = entry.message.payload;
  if (entry.message.messageType === "TEXT") {
    return typeof payload.text === "string" ? payload.text : "[invalid text payload]";
  }
  if (entry.message.messageType === "IMAGE") {
    const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl : "(image)";
    const caption = typeof payload.caption === "string" ? payload.caption : "";
    return `[IMAGE ${imageUrl}]${caption.length === 0 ? "" : `\n${caption}`}`;
  }
  if (entry.message.messageType === "REACTION") {
    const emoji = typeof payload.emoji === "string" ? payload.emoji : "?";
    const target =
      typeof payload.targetExternalMessageId === "string" ? payload.targetExternalMessageId : "?";
    return `[REACTION ${emoji} -> ${target}]`;
  }
  return `[${entry.message.messageType}] ${JSON.stringify(payload)}`;
}

function printEntries(entries: readonly SimulatedWhatsAppTranscriptEntry[]): void {
  for (const entry of entries) {
    if (entry.direction === "SYSTEM") {
      console.log(`[sim] ${entry.event}${entry.detail === null ? "" : ` | ${entry.detail}`}`);
      continue;
    }
    if (entry.direction === "INBOUND") {
      console.log(
        `[${shortRef(entry.message.senderRef)} -> ${shortRef(entry.message.chatRef)}] ${entry.message.text ?? "[media]"}`,
      );
      continue;
    }
    console.log(
      `[BOT -> ${shortRef(entry.message.destinationRef)}] ${renderOutbound(entry)}\n  id=${entry.providerExternalMessageId}`,
    );
  }
}

async function listGroups(pool: Pool): Promise<readonly ListedGroup[]> {
  const result = await pool.query<{
    chat_ref: string;
    role: string;
    display_name: string;
  }>(
    `SELECT chat_ref, role, display_name
     FROM community_groups
     WHERE provider = 'baileys'
       AND status = 'ACTIVE'
     ORDER BY role, display_name, chat_ref`,
  );
  return result.rows.map((row) => ({
    chatRef: row.chat_ref,
    role: row.role,
    displayName: row.display_name,
  }));
}

async function listActors(pool: Pool): Promise<readonly ListedActor[]> {
  const [players, admins] = await Promise.all([
    pool.query<{
      ref: string;
      label: string;
    }>(
      `SELECT identity.external_id AS ref,
              COALESCE(profile.trainer_name, 'Jogador') AS label
       FROM player_identities identity
       LEFT JOIN player_profiles profile ON profile.player_id = identity.player_id
       WHERE identity.provider = 'baileys'
         AND identity.status = 'ACTIVE'
       ORDER BY label, identity.external_id`,
    ),
    pool.query<{
      ref: string;
      label: string;
    }>(
      `SELECT substring(principal.identity_ref FROM 10) AS ref,
              COALESCE(string_agg(role.name, ', ' ORDER BY role.name), 'Admin') AS label
       FROM admin_principals principal
       LEFT JOIN admin_principal_roles principal_role
         ON principal_role.principal_id = principal.id
       LEFT JOIN admin_roles role ON role.id = principal_role.role_id
       WHERE principal.status = 'ACTIVE'
         AND principal.identity_ref LIKE 'whatsapp:%'
         AND length(principal.identity_ref) > 9
       GROUP BY principal.id, principal.identity_ref
       ORDER BY label, principal.identity_ref`,
    ),
  ]);

  return [
    ...players.rows.map((row): ListedActor => ({ ref: row.ref, kind: "PLAYER", label: row.label })),
    ...admins.rows.map((row): ListedActor => ({ ref: row.ref, kind: "ADMIN", label: row.label })),
  ];
}

function selectedByIndex<T>(items: readonly T[], raw: string): T | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const index = Number(raw.trim()) - 1;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return items[index] ?? null;
}

function helpText(): string {
  return [
    "Controles do simulador:",
    "  :groups                 lista grupos WhatsApp registrados",
    "  :chat <n|jid>           escolhe o grupo atual",
    "  :actors                 lista jogadores e ADMs conhecidos",
    "  :as <n|jid|numero>      escolhe quem envia a mensagem",
    "  :join                   simula entrada do ator no grupo atual",
    "  :leave                  simula saída do ator do grupo atual",
    "  :replylast <texto>      responde à última mensagem do bot no grupo",
    "  :replylastmulti          resposta multilinha; finalize com .send",
    "  :multiline               mensagem multilinha; finalize com .send",
    "  :fail [n]               faz os próximos n envios do bot falharem",
    "  :disconnect             derruba o transporte simulado",
    "  :connect                reconecta o transporte simulado",
    "  :flush                  força manutenção + outbox",
    "  :transcript [n]         mostra as últimas n entradas (padrão 20)",
    "  :state                  mostra ator/grupo selecionados",
    "  :help                   mostra esta ajuda",
    "  :quit                   encerra",
    "",
    "Qualquer outra linha é enviada exatamente ao runtime real do bot.",
    "Ex.: $menu, $registrar, /onde, /ir 1",
  ].join("\n");
}

function lastOutboundId(adapter: SimulatedWhatsAppAdapter, chatRef: string | null): string | null {
  for (let index = adapter.transcript.length - 1; index >= 0; index -= 1) {
    const entry = adapter.transcript[index];
    if (
      entry !== undefined &&
      entry.direction === "OUTBOUND" &&
      (chatRef === null || entry.message.destinationRef === chatRef)
    ) {
      return entry.providerExternalMessageId;
    }
  }
  return null;
}

async function persistedLastOutboundId(pool: Pool, chatRef: string | null): Promise<string | null> {
  if (chatRef === null) return null;
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM outbox_messages
     WHERE channel='whatsapp'
       AND destination_ref=$1
       AND status='SENT'
     ORDER BY sent_at DESC NULLS LAST, created_at DESC, id DESC
     LIMIT 1`,
    [chatRef],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) return null;
  const compactUuid = id.replaceAll("-", "").toUpperCase();
  return /^[0-9A-F]{32}$/.test(compactUuid) ? compactUuid : null;
}

async function runShell(
  pool: Pool,
  operational: OperationalSimulatedWhatsAppRuntime,
): Promise<void> {
  const rl = createInterface({ input, output });
  let currentSender = process.env.SIMULATOR_SENDER_REF?.trim() || null;
  let currentChat = process.env.SIMULATOR_CHAT_REF?.trim() || null;
  let groups: readonly ListedGroup[] = [];
  let actors: readonly ListedActor[] = [];
  let transcriptCursor = 0;

  const printNewTranscript = (): void => {
    const entries = operational.adapter.transcript.slice(transcriptCursor);
    printEntries(entries);
    transcriptCursor = operational.adapter.transcript.length;
  };

  const flush = async (): Promise<void> => {
    const result = await operational.runtime.flushOutbox();
    printNewTranscript();
    if (result.claimed > 0 || result.failed > 0) {
      console.log(
        `[sim] outbox claimed=${result.claimed} sent=${result.sent} failed=${result.failed}`,
      );
    }
  };

  const requireSelection = (): { readonly sender: string; readonly chat: string } | null => {
    if (currentSender === null || currentChat === null) {
      console.log("[sim] escolha ator com :as e grupo com :chat antes de enviar.");
      return null;
    }
    return { sender: currentSender, chat: currentChat };
  };

  const sendText = async (text: string, replyToExternalMessageId: string | null): Promise<void> => {
    const selection = requireSelection();
    if (selection === null) return;
    await operational.adapter.injectText({
      senderRef: selection.sender,
      chatRef: selection.chat,
      text,
      replyToExternalMessageId,
    });
    printNewTranscript();
    await flush();
  };

  const resolveLastOutboundId = async (): Promise<string | null> =>
    lastOutboundId(operational.adapter, currentChat) ??
    (await persistedLastOutboundId(pool, currentChat));

  const readMultiline = async (): Promise<string | null> => {
    console.log("[sim] modo multilinha: finalize com .send; cancele com .cancel");
    const lines: string[] = [];
    let length = 0;
    while (true) {
      const line = await rl.question("... ");
      if (line === ".cancel") {
        console.log("[sim] mensagem multilinha cancelada.");
        return null;
      }
      if (line === ".send") {
        if (lines.length === 0) {
          console.log("[sim] mensagem multilinha vazia; nada enviado.");
          return null;
        }
        return lines.join("\n");
      }
      length += line.length + (lines.length === 0 ? 0 : 1);
      if (length > 32_768) {
        console.log("[sim] limite de 32768 caracteres excedido; mensagem cancelada.");
        return null;
      }
      lines.push(line);
    }
  };

  await operational.runtime.start();
  printNewTranscript();
  console.log("Pokemon RPG - WhatsApp Simulator");
  console.log("Transporte real Baileys/auth: DESATIVADO");
  console.log("Digite :help para os controles.\n");

  try {
    while (true) {
      const line = await rl.question(`${shortRef(currentSender)}@${shortRef(currentChat)}> `);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (!trimmed.startsWith(":")) {
        await sendText(line, null);
        continue;
      }

      const firstSpace = trimmed.indexOf(" ");
      const command = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const argument = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();

      switch (command) {
        case ":help":
          console.log(helpText());
          break;
        case ":quit":
        case ":exit":
          return;
        case ":groups":
          groups = await listGroups(pool);
          if (groups.length === 0) {
            console.log("[sim] nenhum grupo baileys ACTIVE registrado.");
            break;
          }
          groups.forEach((group, index) => {
            console.log(`[${index + 1}] ${group.role} | ${group.displayName} | ${group.chatRef}`);
          });
          break;
        case ":actors":
          actors = await listActors(pool);
          if (actors.length === 0) {
            console.log("[sim] nenhum jogador/ADM WhatsApp ativo encontrado.");
            break;
          }
          actors.forEach((actor, index) => {
            console.log(`[${index + 1}] ${actor.kind} | ${actor.label} | ${actor.ref}`);
          });
          break;
        case ":chat": {
          if (argument.length === 0) {
            console.log("uso: :chat <n|jid>");
            break;
          }
          if (/^\d+$/.test(argument)) {
            if (groups.length === 0) groups = await listGroups(pool);
            const selected = selectedByIndex(groups, argument);
            if (selected === null) {
              console.log("[sim] índice de grupo inválido; use :groups.");
              break;
            }
            currentChat = selected.chatRef;
          } else {
            currentChat = argument;
          }
          console.log(`[sim] chat=${currentChat}`);
          break;
        }
        case ":as": {
          if (argument.length === 0) {
            console.log("uso: :as <n|jid|numero>");
            break;
          }
          if (/^\d+$/.test(argument) && actors.length > 0) {
            const selected = selectedByIndex(actors, argument);
            currentSender = selected === null ? normalizeActorRef(argument) : selected.ref;
          } else {
            currentSender = normalizeActorRef(argument);
          }
          console.log(`[sim] sender=${currentSender}`);
          break;
        }
        case ":join":
        case ":leave": {
          const selection = requireSelection();
          if (selection === null) break;
          await operational.adapter.injectMembership({
            chatRef: selection.chat,
            externalId: selection.sender,
            action: command === ":join" ? "add" : "remove",
          });
          printNewTranscript();
          await flush();
          break;
        }
        case ":replylast": {
          if (argument.length === 0) {
            console.log("uso: :replylast <texto>");
            break;
          }
          const replyId = await resolveLastOutboundId();
          if (replyId === null) {
            console.log("[sim] nenhuma mensagem anterior do bot encontrada neste chat.");
            break;
          }
          await sendText(argument, replyId);
          break;
        }
        case ":replylastmulti": {
          const replyId = await resolveLastOutboundId();
          if (replyId === null) {
            console.log("[sim] nenhuma mensagem anterior do bot encontrada neste chat.");
            break;
          }
          const text = await readMultiline();
          if (text !== null) await sendText(text, replyId);
          break;
        }
        case ":multiline": {
          const text = await readMultiline();
          if (text !== null) await sendText(text, null);
          break;
        }
        case ":fail": {
          const count = argument.length === 0 ? 1 : Number(argument);
          if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
            console.log("uso: :fail [1..100]");
            break;
          }
          operational.adapter.failNext(count);
          console.log(`[sim] próximos ${count} envio(s) do bot irão falhar.`);
          break;
        }
        case ":disconnect":
          await operational.adapter.setConnected(false);
          printNewTranscript();
          break;
        case ":connect":
          await operational.adapter.setConnected(true);
          printNewTranscript();
          break;
        case ":flush":
          await flush();
          break;
        case ":transcript": {
          const count = argument.length === 0 ? 20 : Number(argument);
          if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
            console.log("uso: :transcript [1..500]");
            break;
          }
          printEntries(operational.adapter.transcript.slice(-count));
          break;
        }
        case ":state":
          console.log(`[sim] sender=${currentSender ?? "(unset)"}`);
          console.log(`[sim] chat=${currentChat ?? "(unset)"}`);
          console.log(`[sim] lastBotMessageId=${(await resolveLastOutboundId()) ?? "(none)"}`);
          break;
        default:
          console.log(`[sim] controle desconhecido: ${command}. Use :help.`);
      }
    }
  } finally {
    rl.close();
    await operational.runtime.stop();
  }
}

const simulatorDatabaseUrl = process.env.SIMULATOR_DATABASE_URL?.trim();
if (simulatorDatabaseUrl === undefined || simulatorDatabaseUrl.length === 0) {
  throw new Error(
    "SIMULATOR_DATABASE_URL is required; the simulator never defaults to DATABASE_URL",
  );
}
if (process.env.DATABASE_URL?.trim() === simulatorDatabaseUrl) {
  throw new Error(
    "SIMULATOR_DATABASE_URL must be different from DATABASE_URL to protect the canonical local database",
  );
}

const config = loadConfig({
  ...process.env,
  APP_ENV: "development",
  DATABASE_URL: simulatorDatabaseUrl,
  MIGRATOR_DATABASE_URL: simulatorDatabaseUrl,
});
const pool = createDatabasePool({
  connectionString: config.databaseUrl,
  applicationName: "pokemon-rpg-whatsapp-simulator",
  maxConnections: config.databasePoolMax,
  connectionTimeoutMs: config.databaseConnectTimeoutMs,
  idleTimeoutMs: config.databaseIdleTimeoutMs,
  queryTimeoutMs: config.databaseQueryTimeoutMs,
  statementTimeoutMs: config.databaseStatementTimeoutMs,
  idleInTransactionSessionTimeoutMs: config.databaseIdleInTransactionTimeoutMs,
});

try {
  await assertDatabaseSchemaCurrent(pool);
  const rng = simulatorRngConfig();
  const pveBattleConfig = simulatorPveConfig(rng);
  const worldServiceMedia = loadWorldServiceMediaRuntimeConfig(process.env);
  const operational = createOperationalSimulatedWhatsAppRuntime({
    pool,
    encounterRngConfig: rng,
    pveBattleConfig,
    ...(worldServiceMedia === null ? {} : { worldServiceMedia }),
    hubPublicUrl: process.env.SIMULATOR_HUB_PUBLIC_URL?.trim() || null,
  });
  await runShell(pool, operational);
} finally {
  await closeDatabasePool(pool);
}
