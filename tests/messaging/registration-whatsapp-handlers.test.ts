import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import type {
  RegistrationDraftRecord,
  RegistrationRevisionRecord,
} from "../../src/modules/registration/ports.js";
import {
  createRegistrationWhatsAppRoutes,
  type RegistrationSetup,
} from "../../src/modules/registration/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "00000000-0000-4000-8000-000000000401";

function context(text: string, messageId = text): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000301",
    correlationId: "00000000-0000-4000-8000-000000000302",
    causationId: "00000000-0000-4000-8000-000000000301",
    idempotencyKey: `inbox:whatsapp:${messageId}`,
    message: {
      provider: "whatsapp",
      externalMessageId: `registration-command-${messageId}`,
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

function review(
  status: RegistrationRevisionRecord["status"] = "SUBMITTED",
  revision = 0,
): RegistrationRevisionRecord {
  return {
    id: REVIEW_ID,
    playerId: PLAYER_ID,
    sequenceNo: 1,
    status,
    snapshot: completedDraft(),
    revision,
  };
}

function dependencies(
  sessions = new RegistrationConversationSessions(),
  initialDraft: RegistrationDraftRecord | null = null,
  initialReview: RegistrationRevisionRecord | null = null,
) {
  let persistedDraft = initialDraft;
  let currentReview = initialReview;
  let confirmationPreview: string | null = null;
  let draftLoadCount = 0;
  const submissionInputs: unknown[] = [];
  const withdrawalInputs: unknown[] = [];
  return {
    sessions,
    submissionInputs,
    withdrawalInputs,
    get draftLoadCount() {
      return draftLoadCount;
    },
    setCurrentReview(next: RegistrationRevisionRecord | null) {
      currentReview = next;
    },
    players: {
      resolveOrCreatePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: "NEW" as const, created: true }),
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
    },
    registration: {
      getDraft: async () => {
        draftLoadCount += 1;
        return persistedDraft === null
          ? err(appError("NOT_FOUND", "Registration draft not found"))
          : ok(persistedDraft);
      },
      getCurrentReview: async () =>
        currentReview === null
          ? err(appError("NOT_FOUND", "Current registration review not found"))
          : ok(currentReview),
      saveConfirmationPreview: async (_playerId: typeof PLAYER_ID, fingerprint: string) => {
        confirmationPreview = fingerprint;
      },
      getConfirmationPreview: async () => confirmationPreview,
      clearConfirmationPreview: async () => {
        confirmationPreview = null;
      },
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
        currentReview = {
          id: REVIEW_ID,
          playerId: input.playerId,
          sequenceNo: 1,
          status: "SUBMITTED",
          snapshot: input.draft,
          revision: 0,
        };
        return ok({ ...currentReview, replayed: false });
      },
      withdraw: async (input: {
        readonly playerId: typeof PLAYER_ID;
        readonly revisionId: string;
        readonly expectedRevision: number;
      }) => {
        withdrawalInputs.push(input);
        if (currentReview === null || currentReview.id !== input.revisionId) {
          return err(appError("NOT_FOUND", "Current registration review not found"));
        }
        if (currentReview.status !== "SUBMITTED") {
          return err(
            appError("INVALID_STATE_TRANSITION", "Only submitted registration can be withdrawn"),
          );
        }
        if (currentReview.revision !== input.expectedRevision) {
          return err(appError("REVISION_CONFLICT", "Registration review revision conflict"));
        }
        currentReview = {
          ...currentReview,
          status: "WITHDRAWN",
          revision: currentReview.revision + 1,
        };
        return ok(currentReview);
      },
    },
    setup: {
      load: async (): Promise<Result<RegistrationSetup>> =>
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
    for (const command of [
      "registrar",
      "modo",
      "ficha",
      "salvar",
      "continuar",
      "editar",
      "confirmar",
    ]) {
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

  it("shows canonical starter choices when a resumed draft only lacks its starter", async () => {
    const sessions = new RegistrationConversationSessions();
    const { starterFormId: _starterFormId, ...withoutStarter } = completedDraft();
    const deps = dependencies(sessions, {
      playerId: PLAYER_ID,
      revision: 4,
      snapshot: withoutStarter,
    });
    deps.setup.load = async () =>
      ok({
        regionId: ZHOULIA_ID,
        regionDisplayName: "Zhoulia",
        starterOptions: [
          { formId: CHARMANDER_ID, displayName: "Charmander" },
          { formId: "33333333-3333-4333-8333-333333333333", displayName: "Squirtle" },
        ],
      });
    const continuar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "continuar",
    );
    if (continuar === undefined) throw new Error("Missing registration route continuar");

    const result = await continuar.handler.handle(context("$continuar"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toMatch(/Charmander[\s\S]*Squirtle/i);
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      currentField: "starterFormId",
      expectedReplyOutboxIdempotencyKey: "inbox:whatsapp:$continuar:registration-command",
    });
  });

  it("shows canonical starter choices after saving a draft that only lacks its starter", async () => {
    const sessions = new RegistrationConversationSessions();
    const { starterFormId: _starterFormId, ...withoutStarter } = completedDraft();
    sessions.start(PLAYER_ID, { mode: "GUIDED", regionId: ZHOULIA_ID, baseDraft: withoutStarter });
    const deps = dependencies(sessions);
    deps.setup.load = async () =>
      ok({
        regionId: ZHOULIA_ID,
        regionDisplayName: "Zhoulia",
        starterOptions: [{ formId: CHARMANDER_ID, displayName: "Charmander" }],
      });
    const salvar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "salvar",
    );
    if (salvar === undefined) throw new Error("Missing registration route salvar");

    const result = await salvar.handler.handle(context("$salvar"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toContain("Charmander");
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      currentField: "starterFormId",
      expectedReplyOutboxIdempotencyKey: "inbox:whatsapp:$salvar:registration-command",
    });
  });

  it("asks for explicit withdrawal confirmation before editing a submitted review", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("SUBMITTED", 2),
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    const result = await editar.handler.handle(context("$editar"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        outgoing: [{ payload: { text: expect.stringMatching(/análise[\s\S]*\/editar sim/i) } }],
      },
    });
    expect(deps.withdrawalInputs).toEqual([]);
    expect(sessions.get(PLAYER_ID)).toBeNull();
  });

  it("rejects direct submitted-review withdrawal without the preceding edit confirmation", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("SUBMITTED", 2),
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    expect(await editar.handler.handle(context("$editar sim"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(deps.withdrawalInputs).toEqual([]);
    expect(sessions.get(PLAYER_ID)).toBeNull();
  });

  it("invalidates withdrawal confirmation if the submitted review changes before confirmation", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("SUBMITTED", 2),
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    expect(await editar.handler.handle(context("$editar"))).toMatchObject({ ok: true });
    deps.setCurrentReview(review("SUBMITTED", 3));

    expect(await editar.handler.handle(context("$editar sim"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(deps.withdrawalInputs).toEqual([]);
    expect(sessions.get(PLAYER_ID)).toBeNull();
  });

  it("withdraws the exact submitted review and reopens its persisted draft after explicit confirmation", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("SUBMITTED", 2),
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    expect(await editar.handler.handle(context("$editar"))).toMatchObject({ ok: true });
    const result = await editar.handler.handle(context("$editar sim"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(
                /EDITAR REGISTRO[\s\S]*`1`.*Nome[\s\S]*`7`.*Pokémon[\s\S]*\/editar 5[\s\S]*\/modo completo/i,
              ),
            },
          },
        ],
      },
    });
    expect(deps.withdrawalInputs).toEqual([
      { playerId: PLAYER_ID, revisionId: REVIEW_ID, expectedRevision: 2 },
    ]);
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      persistedRevision: 4,
      dirty: false,
      working: completedDraft(),
    });
  });

  it("reopens requested changes immediately while preserving the persisted ficha", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("CHANGES_REQUESTED", 1),
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    const result = await editar.handler.handle(context("$editar"));

    expect(result).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringMatching(/EDITAR REGISTRO/i) } }] },
    });
    expect(deps.withdrawalInputs).toEqual([]);
    if (!result.ok) throw result.error;
    expect(result.value.outgoing[0]?.payload.text).not.toContain("✏️");
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      persistedRevision: 4,
      dirty: false,
      working: completedDraft(),
    });
  });

  it("reopens a rejected review's preserved ficha for the normal Batch E editor", async () => {
    const sessions = new RegistrationConversationSessions();
    const rejected = review("REJECTED", 1);
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      rejected,
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    const result = await editar.handler.handle(context("$editar"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toContain("EDITAR REGISTRO");
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      persistedRevision: 4,
      dirty: false,
      working: completedDraft(),
    });
    expect(rejected).toMatchObject({ status: "REJECTED", snapshot: completedDraft() });
    expect(deps.withdrawalInputs).toEqual([]);
  });

  it("edits one selected field after changes are requested without losing the rest of the ficha", async () => {
    const sessions = new RegistrationConversationSessions();
    const submitted = review("CHANGES_REQUESTED", 1);
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      submitted,
    );
    const routes = createRegistrationWhatsAppRoutes(deps);
    const find = (command: string) => {
      const found = routes.find((candidate) => candidate.command === command);
      if (found === undefined) throw new Error(`Missing registration route ${command}`);
      return found;
    };

    expect(await find("editar").handler.handle(context("$editar"))).toMatchObject({ ok: true });
    const selection = await find("editar").handler.handle(context("$editar 5"));
    expect(selection).toMatchObject({
      ok: true,
      value: {
        outgoing: [{ payload: { text: expect.stringMatching(/Personalidade[\s\S]*responda/i) } }],
      },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({ currentField: "personality" });

    expect(sessions.applyGuidedAnswer(PLAYER_ID, "Mais calma e observadora.")).toMatchObject({
      ok: true,
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      working: {
        ...completedDraft(),
        personality: "Mais calma e observadora.",
      },
      dirty: true,
      currentField: null,
    });

    const ficha = await find("ficha").handler.handle(context("$ficha"));
    if (!ficha.ok) throw ficha.error;
    expect(ficha.value.outgoing[0]?.payload.text).toContain("Mais calma e observadora.");

    expect(await find("confirmar").handler.handle(context("$confirmar"))).toMatchObject({
      ok: true,
    });
    expect(deps.submissionInputs).toEqual([]);
    expect(await find("confirmar").handler.handle(context("$confirmar sim"))).toMatchObject({
      ok: true,
    });
    expect(deps.submissionInputs).toEqual([
      expect.objectContaining({
        draft: { ...completedDraft(), personality: "Mais calma e observadora." },
        expectedDraftRevision: 4,
      }),
    ]);
    expect(submitted.snapshot).toEqual(completedDraft());
  });

  it("keeps full mode available after reopening a complete requested-changes ficha", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("CHANGES_REQUESTED", 1),
    );
    const routes = createRegistrationWhatsAppRoutes(deps);
    const edit = routes.find((candidate) => candidate.command === "editar");
    const mode = routes.find((candidate) => candidate.command === "modo");
    if (edit === undefined || mode === undefined)
      throw new Error("Missing registration edit routes");

    expect(await edit.handler.handle(context("$editar"))).toMatchObject({ ok: true });
    expect(await mode.handler.handle(context("$modo completo"))).toMatchObject({
      ok: true,
      value: { outgoing: [{ payload: { text: expect.stringContaining("FICHA COMPLETA") } }] },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({ mode: "FULL" });
  });

  it("answers an invalid edit selector directly without changing the active draft", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "GUIDED",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    sessions.expectReply(PLAYER_ID, "registration:existing-edit-prompt");
    const before = sessions.get(PLAYER_ID);
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("CHANGES_REQUESTED", 1),
    );
    const edit = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (edit === undefined) throw new Error("Missing registration route editar");

    for (const command of ["$editar 8", "$editar foo"]) {
      const result = await edit.handler.handle(context(command));
      if (!result.ok) throw result.error;
      expect(result.value.outgoing[0]?.payload.text).toMatch(/\/editar 1[\s\S]*\/editar 7/i);
      expect(result.value.outgoing[0]?.payload.text).not.toContain("Código de suporte");
      expect(sessions.get(PLAYER_ID)).toEqual(before);
    }
  });

  it("selects the canonical starter options and finishes only the selected starter field", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "GUIDED",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    sessions.expectReply(PLAYER_ID, "registration:existing-edit-prompt");
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("CHANGES_REQUESTED", 1),
    );
    deps.setup.load = async () =>
      ok({
        regionId: ZHOULIA_ID,
        regionDisplayName: "Zhoulia",
        starterOptions: [
          { formId: CHARMANDER_ID, displayName: "Charmander" },
          { formId: "33333333-3333-4333-8333-333333333333", displayName: "Squirtle" },
        ],
      });
    const edit = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (edit === undefined) throw new Error("Missing registration route editar");

    const result = await edit.handler.handle(context("$editar 7"));
    if (!result.ok) throw result.error;
    expect(result.value.outgoing[0]?.payload.text).toMatch(
      /Charmander[\s\S]*Squirtle[\s\S]*número ou o nome/i,
    );
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      currentField: "starterFormId",
      expectedReplyOutboxIdempotencyKey: "inbox:whatsapp:$editar 7:registration-command",
    });

    expect(
      sessions.applyGuidedAnswer(PLAYER_ID, "33333333-3333-4333-8333-333333333333"),
    ).toMatchObject({
      ok: true,
      value: { currentField: null },
    });
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      working: { ...completedDraft(), starterFormId: "33333333-3333-4333-8333-333333333333" },
      currentField: null,
    });
  });

  it("does not change the current edit state when starter setup cannot load", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "GUIDED",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    sessions.expectReply(PLAYER_ID, "registration:existing-edit-prompt");
    const before = sessions.get(PLAYER_ID);
    const deps = dependencies(sessions);
    deps.setup.load = async () => err(appError("FEATURE_UNAVAILABLE", "starter setup unavailable"));
    const edit = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (edit === undefined) throw new Error("Missing registration route editar");

    expect(await edit.handler.handle(context("$editar 7"))).toMatchObject({
      ok: false,
      error: { code: "FEATURE_UNAVAILABLE" },
    });
    expect(sessions.get(PLAYER_ID)).toEqual(before);
  });

  it("fails closed if an approved registration reaches the player edit route", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(
      sessions,
      { playerId: PLAYER_ID, revision: 4, snapshot: completedDraft() },
      review("APPROVED", 1),
    );
    const editar = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "editar",
    );
    if (editar === undefined) throw new Error("Missing registration route editar");

    expect(await editar.handler.handle(context("$editar"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(sessions.get(PLAYER_ID)).toBeNull();
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
                /PRÉVIA DE ENVIO[\s\S]*AINDA NÃO ENVIADO[\s\S]*Liora Vale[\s\S]*Charmander[\s\S]*Zhoulia[\s\S]*\/confirmar sim/i,
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
        outgoing: [
          { payload: { text: expect.stringMatching(/enviada.*análise/i) } },
          expect.anything(),
        ],
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

  it("persists a preview across independently composed confirmation routes", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });
    const deps = dependencies(sessions);
    const preview = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "confirmar",
    );
    const submit = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "confirmar",
    );
    if (preview === undefined || submit === undefined)
      throw new Error("Missing confirmation route");

    expect(
      await preview.handler.handle(context("/confirmar", "independent-preview")),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await submit.handler.handle(context("/confirmar sim", "independent-submit")),
    ).toMatchObject({ ok: true });
    expect(deps.submissionInputs).toHaveLength(1);
  });

  it("acknowledges a second /confirmar sim after submission without submitting or notifying twice", async () => {
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

    expect(await confirmar.handler.handle(context("/confirmar", "preview"))).toMatchObject({
      ok: true,
    });
    expect(
      await confirmar.handler.handle(context("/confirmar sim", "first-confirmation")),
    ).toMatchObject({ ok: true });

    const repeated = await confirmar.handler.handle(
      context("/confirmar sim", "second-confirmation"),
    );

    expect(repeated).toMatchObject({
      ok: true,
      value: {
        outgoing: [{ payload: { text: expect.stringMatching(/j[aá] foi enviada.*an[aá]lise/i) } }],
      },
    });
    expect(deps.submissionInputs).toHaveLength(1);
    if (!repeated.ok) throw repeated.error;
    expect(repeated.value.outgoing).toHaveLength(1);

    for (const [status, expected] of [
      ["SUBMITTED", /já foi enviada.*análise/i],
      ["APPROVED", /já foi aprovada.*ativação/i],
      ["CHANGES_REQUESTED", /aguarda ajustes.*\/editar/i],
      ["REJECTED", /não está disponível.*\/editar/i],
      ["WITHDRAWN", /foi retirada.*\/(ficha|editar)/i],
    ] as const) {
      deps.setCurrentReview(review(status));
      const result = await confirmar.handler.handle(context("/confirmar sim", `state-${status}`));
      expect(result).toMatchObject({
        ok: true,
        value: { outgoing: [{ payload: { text: expect.stringMatching(expected) } }] },
      });
      expect(deps.submissionInputs).toHaveLength(1);
    }
  });
});

it("offers the next confirmation step when viewing a complete saved ficha", async () => {
  const sessions = new RegistrationConversationSessions();
  sessions.start(PLAYER_ID, {
    mode: "GUIDED",
    regionId: ZHOULIA_ID,
    baseDraft: completedDraft(),
    baseRevision: 6,
  });
  const { found } = route("ficha", sessions);
  const result = await found.handler.handle(context("/ficha"));
  if (!result.ok) throw result.error;
  expect(result.value.outgoing[0]?.payload.text).toContain("/confirmar");
  expect(result.value.outgoing[0]?.payload.text).not.toContain("\n\n\n");
  expect(sessions.get(PLAYER_ID)?.persistedRevision).toBe(6);
});

it("does not duplicate the success heading when saving a complete ficha", async () => {
  const sessions = new RegistrationConversationSessions();
  sessions.start(PLAYER_ID, {
    mode: "GUIDED",
    regionId: ZHOULIA_ID,
    baseDraft: completedDraft(),
    baseRevision: 6,
  });
  const { found } = route("salvar", sessions);
  const result = await found.handler.handle(context("/salvar"));
  if (!result.ok) throw result.error;

  expect(result.value.outgoing[0]?.payload.text).toContain("RASCUNHO SALVO");
  expect(result.value.outgoing[0]?.payload.text).not.toContain("REGISTRO PREENCHIDO");
  expect(result.value.outgoing[0]?.payload.text).toContain("/confirmar");
});

describe("persisted /ficha truthfulness", () => {
  it("restores and renders a complete persisted draft when no session exists", async () => {
    const sessions = new RegistrationConversationSessions();
    const persisted = { playerId: PLAYER_ID, revision: 8, snapshot: completedDraft() };
    const deps = dependencies(sessions, persisted);
    const ficha = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "ficha",
    );
    if (ficha === undefined) throw new Error("Missing registration route ficha");

    const result = await ficha.handler.handle(context("/ficha"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toContain("Liora Vale");
    expect(result.value.outgoing[0]?.payload.text).toContain("/confirmar");
    expect(deps.draftLoadCount).toBe(1);
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      currentField: null,
      working: completedDraft(),
      persistedRevision: 8,
      dirty: false,
    });
  });

  it("restores an incomplete persisted draft and directs the player to finish it", async () => {
    const sessions = new RegistrationConversationSessions();
    const persisted = {
      playerId: PLAYER_ID,
      revision: 3,
      snapshot: {
        trainerName: "Liora Parcial",
        regionId: ZHOULIA_ID,
        schemaVersion: 1,
      },
    };
    const deps = dependencies(sessions, persisted);
    const ficha = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "ficha",
    );
    if (ficha === undefined) throw new Error("Missing registration route ficha");

    const result = await ficha.handler.handle(context("/ficha"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toContain("Liora Parcial");
    expect(result.value.outgoing[0]?.payload.text).toMatch(/\*Idade\* › —/);
    expect(result.value.outgoing[0]?.payload.text).toContain("/salvar");
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      mode: "GUIDED",
      currentField: "age",
      working: persisted.snapshot,
      persistedRevision: 3,
      dirty: false,
    });
  });

  it("keeps a dirty in-memory session instead of loading persisted state", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: { ...completedDraft(), trainerName: "Sessão Local" },
      baseRevision: 4,
    });
    sessions.setField(PLAYER_ID, "personality", "Alteração ainda não salva.");
    const deps = dependencies(sessions, {
      playerId: PLAYER_ID,
      revision: 9,
      snapshot: { ...completedDraft(), trainerName: "Banco Antigo" },
    });
    const ficha = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "ficha",
    );
    if (ficha === undefined) throw new Error("Missing registration route ficha");

    const result = await ficha.handler.handle(context("/ficha"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toContain("Sessão Local");
    expect(result.value.outgoing[0]?.payload.text).toContain("Alteração ainda não salva.");
    expect(result.value.outgoing[0]?.payload.text).not.toContain("Banco Antigo");
    expect(deps.draftLoadCount).toBe(0);
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      persistedRevision: 4,
      dirty: true,
      working: { trainerName: "Sessão Local", personality: "Alteração ainda não salva." },
    });

    sessions.clear(PLAYER_ID);
    const afterRestart = await ficha.handler.handle(context("/ficha"));
    if (!afterRestart.ok) throw afterRestart.error;

    expect(afterRestart.value.outgoing[0]?.payload.text).toContain("Banco Antigo");
    expect(afterRestart.value.outgoing[0]?.payload.text).not.toContain("Sessão Local");
    expect(deps.draftLoadCount).toBe(1);
    expect(sessions.get(PLAYER_ID)).toMatchObject({
      persistedRevision: 9,
      dirty: false,
      working: { trainerName: "Banco Antigo", personality: completedDraft().personality },
    });
  });

  it("sends the player to /registrar when neither a session nor a draft exists", async () => {
    const sessions = new RegistrationConversationSessions();
    const deps = dependencies(sessions);
    const ficha = createRegistrationWhatsAppRoutes(deps).find(
      (candidate) => candidate.command === "ficha",
    );
    if (ficha === undefined) throw new Error("Missing registration route ficha");

    const result = await ficha.handler.handle(context("/ficha"));
    if (!result.ok) throw result.error;

    expect(result.value.outgoing[0]?.payload.text).toMatch(/nenhuma ficha[\s\S]*\/registrar/i);
    expect(deps.draftLoadCount).toBe(1);
    expect(sessions.get(PLAYER_ID)).toBeNull();
  });
});
