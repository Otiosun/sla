import { describe, expect, it } from "vitest";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import type { RegistrationDraftRecord } from "../../src/modules/registration/ports.js";
import { createRegistrationWhatsAppRoutes } from "../../src/modules/registration/whatsapp-handlers.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000301",
    correlationId: "00000000-0000-4000-8000-000000000302",
    causationId: "00000000-0000-4000-8000-000000000301",
    idempotencyKey: `inbox:whatsapp:${text}`,
    message: {
      provider: "whatsapp",
      externalMessageId: `registration-command-${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-02T02:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function completedDraft() {
  return {
    trainerName: "Liora Vale",
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId: CHARMANDER_ID,
    regionId: ZHOULIA_ID,
    schemaVersion: 1,
  } as const;
}

function dependencies(
  sessions = new RegistrationConversationSessions(),
  initialDraft: RegistrationDraftRecord | null = null,
) {
  let persistedDraft = initialDraft;
  const submissionInputs: unknown[] = [];
  return {
    sessions,
    submissionInputs,
    players: {
      resolveOrCreatePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: "NEW" as const, created: true }),
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
    },
    registration: {
      getDraft: async () =>
        persistedDraft === null
          ? err(appError("NOT_FOUND", "Registration draft not found"))
          : ok(persistedDraft),
      saveDraft: async (input: {
        readonly playerId: typeof PLAYER_ID;
        readonly draft: RegistrationDraftRecord["snapshot"];
        readonly expectedRevision: number | null;
      }) => {
        const revision = (persistedDraft?.revision ?? -1) + 1;
        persistedDraft = { playerId: input.playerId, snapshot: input.draft, revision };
        return ok(persistedDraft);
      },
      saveAndSubmit: async (input: {
        readonly playerId: typeof PLAYER_ID;
        readonly draft: ReturnType<typeof completedDraft>;
        readonly expectedDraftRevision: number | null;
        readonly idempotencyKey: string;
      }) => {
        submissionInputs.push(input);
        return ok({
          id: "00000000-0000-4000-8000-000000000401",
          playerId: input.playerId,
          sequenceNo: 1,
          status: "SUBMITTED" as const,
          snapshot: input.draft,
          revision: 0,
          replayed: false,
        });
      },
    },
    setup: {
      load: async () =>
        ok({
          regionId: ZHOULIA_ID,
          regionDisplayName: "Zhoulia",
          starterOptions: [{ formId: CHARMANDER_ID, displayName: "Charmander" }],
        }),
    },
  };
}

function route(command: string, sessions = new RegistrationConversationSessions()) {
  const routes = createRegistrationWhatsAppRoutes(dependencies(sessions));
  const found = routes.find((candidate) => candidate.command === command);
  if (found === undefined) throw new Error(`Missing registration route ${command}`);
  return { found, sessions };
}

describe("registration WhatsApp commands", () => {
  it("declares reception-only pending-player policy for the player registration commands", () => {
    const routes = createRegistrationWhatsAppRoutes(dependencies());
    for (const command of ["registrar", "modo", "ficha", "salvar", "continuar", "confirmar"]) {
      expect(routes.find((candidate) => candidate.command === command)?.policy).toEqual({
        requiredGroupCapabilities: ["onboarding"],
        allowedPlayerAccess: ["PENDING"],
      });
    }
  });

  it("starts registration by asking the player to choose a mode instead of consuming a name argument", async () => {
    const sessions = new RegistrationConversationSessions();
    const { found } = route("registrar", sessions);

    const result = await found.handler.handle(context("$registrar Nome Que Deve Ser Ignorado"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: PLAYER_ID,
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(/1.*guiado[\s\S]*2.*ficha completa/i),
            },
          },
        ],
      },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "CHOOSING",
      currentField: null,
      dirty: false,
      working: { regionId: ZHOULIA_ID, schemaVersion: 1 },
    });
    expect(sessions.get(PLAYER_ID)?.working.trainerName).toBeUndefined();
  });

  it("switches the active editor mode without discarding working values", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(PLAYER_ID, "Liora Vale");
    const { found } = route("modo", sessions);

    const result = await found.handler.handle(context("$modo completo"));

    expect(result).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringContaining("FICHA COMPLETA") } }] },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "FULL",
      working: { trainerName: "Liora Vale", regionId: ZHOULIA_ID },
      dirty: true,
    });
  });

  it("renders the current working ficha and marks unsaved changes without persisting anything", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(PLAYER_ID, "Liora Vale");
    sessions.applyGuidedAnswer(PLAYER_ID, "17");
    const { found } = route("ficha", sessions);

    const result = await found.handler.handle(context("$ficha"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: PLAYER_ID,
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(/Liora Vale[\s\S]*17[\s\S]*Zhoulia[\s\S]*não salvas/i),
            },
          },
        ],
      },
    });
  });

  it("saves the current partial session with optimistic revision and marks it clean", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(PLAYER_ID, "Liora Vale");
    const deps = dependencies(sessions);
    const salvar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "salvar",
    );
    if (salvar === undefined) throw new Error("Missing registration route salvar");

    const result = await salvar.handler.handle(context("$salvar"));

    expect(result).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringMatching(/rascunho.*salv/i) } }] },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      persistedRevision: 0,
      dirty: false,
      currentField: "age",
      working: { trainerName: "Liora Vale" },
    });
  });

  it("continues from a persisted partial draft after the in-memory session is gone", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(sessions, {
      playerId: PLAYER_ID,
      revision: 4,
      snapshot: {
        trainerName: "Liora Vale",
        regionId: ZHOULIA_ID,
        schemaVersion: 1,
      },
    });
    const continuar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "continuar",
    );
    if (continuar === undefined) throw new Error("Missing registration route continuar");

    const result = await continuar.handler.handle(context("$continuar"));

    expect(result).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringMatching(/idade/i) } }] },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      persistedRevision: 4,
      dirty: false,
      currentField: "age",
      working: { trainerName: "Liora Vale", regionId: ZHOULIA_ID },
    });
  });

  it("previews a complete ficha without saving or submitting it", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    sessions.setField(PLAYER_ID, "personality", "Curiosa, competitiva e paciente.");
    const deps = dependencies(sessions);
    const confirmar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "confirmar",
    );
    if (confirmar === undefined) throw new Error("Missing registration route confirmar");

    const result = await confirmar.handler.handle(context("$confirmar"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(
                /CONFIRMAÇÃO[\s\S]*Liora Vale[\s\S]*Charmander[\s\S]*Zhoulia[\s\S]*\$confirmar sim/i,
              ),
            },
          },
        ],
      },
    });
    expect(deps.submissionInputs).toEqual([]);
    expect(sessions.get(PLAYER_ID)).not.toBeNull();
  });

  it("rejects final confirmation when the player has not previewed the exact current ficha", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    const deps = dependencies(sessions);
    const confirmar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "confirmar",
    );
    if (confirmar === undefined) throw new Error("Missing registration route confirmar");

    const result = await confirmar.handler.handle(context("$confirmar sim"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(deps.submissionInputs).toEqual([]);
  });

  it("invalidates a preview if the working ficha changes before final confirmation", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    const deps = dependencies(sessions);
    const confirmar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "confirmar",
    );
    if (confirmar === undefined) throw new Error("Missing registration route confirmar");

    expect(await confirmar.handler.handle(context("$confirmar"))).toMatchObject({ ok: true });
    sessions.setField(PLAYER_ID, "personality", "Agora mudou depois do preview.");

    expect(await confirmar.handler.handle(context("$confirmar sim"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(deps.submissionInputs).toEqual([]);
  });

  it("atomically saves and submits the exact previewed ficha on explicit final confirmation", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    sessions.setField(PLAYER_ID, "personality", "Curiosa, competitiva e paciente.");
    const deps = dependencies(sessions);
    const confirmar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "confirmar",
    );
    if (confirmar === undefined) throw new Error("Missing registration route confirmar");

    expect(await confirmar.handler.handle(context("$confirmar"))).toMatchObject({ ok: true });
    const result = await confirmar.handler.handle(context("$confirmar sim"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        outgoing: [{ payload: { text: expect.stringMatching(/enviada.*análise/i) } }],
      },
    });
    expect(deps.submissionInputs).toEqual([
      {
        playerId: PLAYER_ID,
        draft: {
          ...completedDraft(),
          personality: "Curiosa, competitiva e paciente.",
        },
        expectedDraftRevision: 4,
        idempotencyKey: "inbox:whatsapp:$confirmar sim:registration-submit",
      },
    ]);
    expect(sessions.get(PLAYER_ID)).toBeNull();
  });
});
