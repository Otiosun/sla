import assert from "node:assert/strict";
import { Pool } from "pg";
import { baileysOutboundMessageId } from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import { FakeWhatsAppAdapter } from "../../src/adapters/whatsapp/fake-whatsapp-adapter.js";
import type {
  IncomingMessage,
  PendingOutboxMessage,
} from "../../src/modules/messaging/contracts.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresRegistrationSetupLoader } from "../../src/platform/registration/postgres-registration-setup-loader.js";
import {
  createOperationalMessagingComposition,
  createOperationalOutboxWorker,
} from "../../src/runtime/compose-whatsapp-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for Reception conversation v2 E2E");
}

// The canonical Reception E2E immediately before this proof creates this real
// Reception group, its staff assignment, and an ACTIVE Zhoulia content release.
const RECEPTION_CHAT = "120363000000009001@g.us";
const ADMIN_JID = "5511999999002@s.whatsapp.net";
const GUIDED_PLAYER_JID = "5511999999101@s.whatsapp.net";
const FULL_PLAYER_JID = "5511999999102@s.whatsapp.net";

let sequence = 0;
function incoming(
  senderRef: string,
  text: string,
  replyToExternalMessageId: string | null = null,
): IncomingMessage {
  sequence += 1;
  return {
    provider: "baileys",
    externalMessageId: `reception-v2-e2e:${sequence}`,
    senderRef,
    chatRef: RECEPTION_CHAT,
    occurredAt: new Date(Date.UTC(2026, 8, 6, 19, 0, sequence)).toISOString(),
    text,
    mediaRefs: [],
    replyToExternalMessageId,
  };
}

function isInteractivePrompt(message: PendingOutboxMessage): boolean {
  if (message.destinationRef !== RECEPTION_CHAT) return false;
  const text = message.payload.text;
  return (
    typeof text === "string" &&
    /(?:responda a esta mensagem|respondendo a esta mensagem)/i.test(text)
  );
}

function latestPromptId(messages: readonly PendingOutboxMessage[]): string {
  const prompt = [...messages].reverse().find(isInteractivePrompt);
  if (prompt === undefined) throw new Error("Expected an interactive Reception prompt");
  return baileysOutboundMessageId(prompt);
}

interface Delivery {
  readonly admitted: boolean;
  readonly sent: readonly PendingOutboxMessage[];
}

async function createHarness(pool: Pool) {
  const composition = createOperationalMessagingComposition(pool);
  const repository = new PostgresMessagingRepository(pool);
  const messaging = new MessagingService(repository, composition.router, 30_000, {
    player: { policyKey: "reception.v2.e2e.player", maxEvents: 500, windowMs: 60_000 },
    chat: { policyKey: "reception.v2.e2e.chat", maxEvents: 1_000, windowMs: 60_000 },
    sensitiveAction: {
      policyKey: "reception.v2.e2e.sensitive",
      maxEvents: 500,
      windowMs: 60_000,
    },
  });
  const adapter = new FakeWhatsAppAdapter();
  const outboxWorker = createOperationalOutboxWorker(pool, repository, adapter);

  // Flush anything left by the preceding canonical proof so assertions below
  // only inspect messages caused by this journey.
  await outboxWorker.runOnce();

  const deliver = async (message: IncomingMessage): Promise<Delivery> => {
    const text = message.text?.trim() ?? "";
    const admitted = text.startsWith("$")
      ? composition.admitCommand(message)
      : await composition.admitFreeform(message);
    if (!admitted) return { admitted: false, sent: [] };

    const before = adapter.sent.length;
    const result = await messaging.receive(message);
    if (!result.ok) {
      throw new Error(
        `Reception v2 receive failed [${result.error.code}]: ${result.error.message}`,
      );
    }
    assert.equal(result.value.status, "PROCESSED");
    await composition.runMaintenance();
    await outboxWorker.runOnce();
    return { admitted: true, sent: adapter.sent.slice(before) };
  };

  return { composition, deliver };
}

async function playerIdFor(pool: Pool, externalId: string): Promise<string> {
  const identity = await pool.query<{ player_id: string }>(
    `SELECT player_id
     FROM player_identities
     WHERE provider = 'baileys' AND external_id = $1 AND status = 'ACTIVE'`,
    [externalId],
  );
  const playerId = identity.rows[0]?.player_id;
  if (playerId === undefined) throw new Error(`Player identity ${externalId} is missing`);
  return playerId;
}

async function proveGuidedJourney(pool: Pool): Promise<void> {
  const harness = await createHarness(pool);

  const looseBeforeRegistration = incoming(GUIDED_PLAYER_JID, "oi gente");
  const looseDelivery = await harness.deliver(looseBeforeRegistration);
  assert.equal(looseDelivery.admitted, false);
  assert.equal(looseDelivery.sent.length, 0);

  const unknownCommand = incoming(GUIDED_PLAYER_JID, "$naoexiste");
  const unknownDelivery = await harness.deliver(unknownCommand);
  assert.equal(unknownDelivery.admitted, false);
  assert.equal(unknownDelivery.sent.length, 0);

  const preIdentity = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM player_identities
     WHERE provider = 'baileys' AND external_id = $1`,
    [GUIDED_PLAYER_JID],
  );
  assert.equal(preIdentity.rows[0]?.count, 0);

  const registered = await harness.deliver(incoming(GUIDED_PLAYER_JID, "$registrar"));
  assert.equal(registered.admitted, true);
  let promptId = latestPromptId(registered.sent);
  const modePromptId = promptId;

  const replyToHuman = await harness.deliver(incoming(GUIDED_PLAYER_JID, "1", "HUMAN-MESSAGE-ID"));
  assert.equal(replyToHuman.admitted, false);
  assert.equal(replyToHuman.sent.length, 0);

  const guidedMode = await harness.deliver(incoming(GUIDED_PLAYER_JID, "1", promptId));
  assert.equal(guidedMode.admitted, true);
  assert.match(String(guidedMode.sent.at(-1)?.payload.text ?? ""), /1\/7.*Nome/s);
  promptId = latestPromptId(guidedMode.sent);

  const staleModeReply = await harness.deliver(
    incoming(GUIDED_PLAYER_JID, "Liora Errada", modePromptId),
  );
  assert.equal(staleModeReply.admitted, false);
  assert.equal(staleModeReply.sent.length, 0);

  const answers = [
    "Liora Vale",
    "17",
    "ela/dela",
    "Cabelos negros e casaco de viagem.",
    "Curiosa e competitiva.",
    "Saiu de casa para pesquisar Pokémon raros.",
    "1",
  ] as const;

  for (const answer of answers) {
    const delivered = await harness.deliver(incoming(GUIDED_PLAYER_JID, answer, promptId));
    assert.equal(delivered.admitted, true);
    promptId = latestPromptId(delivered.sent);
  }

  const playerId = await playerIdFor(pool, GUIDED_PLAYER_JID);
  const automaticReview = await pool.query<{ state: string; current_field: string | null }>(
    `SELECT state, current_field
     FROM registration_conversations
     WHERE player_id = $1`,
    [playerId],
  );
  assert.deepEqual(automaticReview.rows[0], { state: "REVIEW", current_field: null });

  const openEdit = await harness.deliver(incoming(GUIDED_PLAYER_JID, "2", promptId));
  assert.equal(openEdit.admitted, true);
  assert.match(String(openEdit.sent.at(-1)?.payload.text ?? ""), /O que deseja corrigir/);
  promptId = latestPromptId(openEdit.sent);

  const chooseName = await harness.deliver(incoming(GUIDED_PLAYER_JID, "1", promptId));
  assert.equal(chooseName.admitted, true);
  assert.match(String(chooseName.sent.at(-1)?.payload.text ?? ""), /Corrigindo.*Nome/s);
  promptId = latestPromptId(chooseName.sent);

  const corrected = await harness.deliver(incoming(GUIDED_PLAYER_JID, "Liora Nova", promptId));
  assert.equal(corrected.admitted, true);
  assert.match(String(corrected.sent.at(-1)?.payload.text ?? ""), /FICHA PRONTA PARA REVISÃO/);
  assert.match(String(corrected.sent.at(-1)?.payload.text ?? ""), /Nome: Liora Nova/);
  promptId = latestPromptId(corrected.sent);

  const submitted = await harness.deliver(incoming(GUIDED_PLAYER_JID, "1", promptId));
  assert.equal(submitted.admitted, true);

  const reviews = await pool.query<{ id: string; status: string; sequence_no: number }>(
    `SELECT id, status, sequence_no::integer AS sequence_no
     FROM registration_revisions
     WHERE player_id = $1
     ORDER BY sequence_no`,
    [playerId],
  );
  assert.equal(reviews.rows.length, 1);
  assert.equal(reviews.rows[0]?.status, "SUBMITTED");
  assert.equal(reviews.rows[0]?.sequence_no, 1);
  const reviewId = reviews.rows[0]?.id;
  if (reviewId === undefined) throw new Error("V2 guided review was not created");

  const conversation = await pool.query<{
    state: string;
    active_prompt_outbox_idempotency_key: string | null;
  }>(
    `SELECT state, active_prompt_outbox_idempotency_key
     FROM registration_conversations
     WHERE player_id = $1`,
    [playerId],
  );
  assert.deepEqual(conversation.rows[0], {
    state: "SUBMITTED",
    active_prompt_outbox_idempotency_key: null,
  });

  const notification = await pool.query<{
    payload: { mentions?: string[]; registrationReview?: unknown };
  }>(
    `SELECT payload
     FROM outbox_messages
     WHERE payload ? 'registrationReview'
       AND payload -> 'registrationReview' ->> 'reviewId' = $1`,
    [reviewId],
  );
  assert.equal(notification.rows.length, 1);
  assert.deepEqual(notification.rows[0]?.payload.mentions, [ADMIN_JID]);
}

async function proveFullMultilineJourney(pool: Pool): Promise<void> {
  const harness = await createHarness(pool);
  const setupResult = await new PostgresRegistrationSetupLoader(pool).load();
  if (!setupResult.ok) {
    throw new Error(
      `Could not load Registration setup [${setupResult.error.code}]: ${setupResult.error.message}`,
    );
  }
  const starter = setupResult.value.starterOptions[0]?.displayName;
  if (starter === undefined) throw new Error("V2 full-form proof requires one starter");

  const registered = await harness.deliver(incoming(FULL_PLAYER_JID, "$registrar"));
  assert.equal(registered.admitted, true);
  let promptId = latestPromptId(registered.sent);

  const fullMode = await harness.deliver(incoming(FULL_PLAYER_JID, "2", promptId));
  assert.equal(fullMode.admitted, true);
  assert.match(String(fullMode.sent.at(-1)?.payload.text ?? ""), /FICHA COMPLETA/);
  promptId = latestPromptId(fullMode.sent);

  const fullForm = [
    "Nome: Mira Sol",
    "Idade: 18",
    "Gênero / pronomes: ela/dela",
    "Aparência:",
    "Cabelos curtos e mochila vermelha.",
    "",
    "Usa botas gastas de viagem.",
    "Personalidade:",
    "Atenta e curiosa.",
    "Fica competitiva quando encontra um mistério.",
    "História / resumo:",
    "Saiu de casa para mapear trilhas antigas.",
    "",
    "Quer catalogar espécies raras sem abandonar a equipe.",
    `Pokémon inicial: ${starter}`,
  ].join("\n");

  const filled = await harness.deliver(incoming(FULL_PLAYER_JID, fullForm, promptId));
  assert.equal(filled.admitted, true);
  assert.match(String(filled.sent.at(-1)?.payload.text ?? ""), /FICHA PRONTA PARA REVISÃO/);

  const playerId = await playerIdFor(pool, FULL_PLAYER_JID);
  const result = await pool.query<{
    state: string;
    appearance: string | null;
    backstory: string | null;
  }>(
    `SELECT conversation.state,
            draft.snapshot_json ->> 'appearance' AS appearance,
            draft.snapshot_json ->> 'backstory' AS backstory
     FROM registration_conversations conversation
     JOIN registration_drafts draft ON draft.player_id = conversation.player_id
     WHERE conversation.player_id = $1`,
    [playerId],
  );
  assert.equal(result.rows[0]?.state, "REVIEW");
  assert.equal(
    result.rows[0]?.appearance,
    "Cabelos curtos e mochila vermelha.\n\nUsa botas gastas de viagem.",
  );
  assert.equal(
    result.rows[0]?.backstory,
    "Saiu de casa para mapear trilhas antigas.\n\nQuer catalogar espécies raras sem abandonar a equipe.",
  );
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const reception = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM community_groups
       WHERE provider = 'baileys' AND chat_ref = $1 AND status = 'ACTIVE'`,
      [RECEPTION_CHAT],
    );
    assert.equal(
      reception.rows[0]?.count,
      1,
      "Run the canonical Reception registration E2E before the v2 proof",
    );

    await proveGuidedJourney(pool);
    await proveFullMultilineJourney(pool);
    console.log("Reception conversation v2 E2E proof passed");
  } finally {
    await pool.end();
  }
}

void main();
