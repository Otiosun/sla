import { describe, expect, it } from "vitest";
import {
  RegistrationConversationSessions,
  parseFullRegistrationTemplate,
} from "../../src/modules/registration/conversation-session.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const SQUIRTLE_ID = "33333333-3333-4333-8333-333333333333";

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

describe("RegistrationConversationSessions", () => {
  it("keeps guided answers ephemeral and advances one field at a time", () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();

    const started = sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    expect(started).toMatchObject({
      mode: "GUIDED",
      currentField: "trainerName",
      dirty: false,
      working: { regionId: ZHOULIA_ID, schemaVersion: 1 },
    });

    expect(sessions.applyGuidedAnswer(playerId, "Liora Vale")).toMatchObject({
      ok: true,
      value: { currentField: "age", dirty: true, working: { trainerName: "Liora Vale" } },
    });
    expect(sessions.applyGuidedAnswer(playerId, "17")).toMatchObject({
      ok: true,
      value: { currentField: "genderPronouns", working: { age: 17 } },
    });
  });

  it("switches guided and full modes without losing working values", () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.start(playerId, { mode: "GUIDED", regionId: ZHOULIA_ID });
    sessions.applyGuidedAnswer(playerId, "Liora Vale");

    const full = sessions.switchMode(playerId, "FULL");
    expect(full).toMatchObject({
      ok: true,
      value: { mode: "FULL", working: { trainerName: "Liora Vale", regionId: ZHOULIA_ID } },
    });

    const guided = sessions.switchMode(playerId, "GUIDED");
    expect(guided).toMatchObject({
      ok: true,
      value: { mode: "GUIDED", working: { trainerName: "Liora Vale" } },
    });
  });

  it("can start from a persisted draft while a fresh process has no unsaved session", () => {
    const playerId = createPlayerId();
    const firstProcess = new RegistrationConversationSessions();
    firstProcess.start(playerId, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
    });
    firstProcess.setField(playerId, "starterFormId", SQUIRTLE_ID);
    expect(firstProcess.get(playerId)?.working.starterFormId).toBe(SQUIRTLE_ID);

    const restartedProcess = new RegistrationConversationSessions();
    expect(restartedProcess.get(playerId)).toBeNull();

    const resumed = restartedProcess.start(playerId, {
      mode: "FULL",
      regionId: ZHOULIA_ID,
      baseDraft: completedDraft(),
    });
    expect(resumed.working.starterFormId).toBe(CHARMANDER_ID);
  });

  it("parses a full template despite harmless spacing, casing and line-break variation", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        " NOME : Liora Vale ",
        "Idade: 17",
        "Pronomes : ela/dela",
        "Aparência:",
        "Cabelos negros e casaco de viagem.",
        "PERSONALIDADE: Curiosa e competitiva.",
        "História : Saiu de casa para pesquisar Pokémon raros.",
        `Inicial: ${SQUIRTLE_ID}`,
      ].join("\n"),
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        appearance: "Cabelos negros e casaco de viagem.",
        personality: "Curiosa e competitiva.",
        backstory: "Saiu de casa para pesquisar Pokémon raros.",
        starterFormId: SQUIRTLE_ID,
      },
    });
  });

  it("rejects ambiguous duplicate fields instead of guessing", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        "Nome: Liora Vale",
        "Nome: Outra Pessoa",
        "Idade: 17",
        "Pronomes: ela/dela",
        "Aparência: Casaco escuro.",
        "Personalidade: Curiosa.",
        "História: Uma história curta.",
        `Inicial: ${CHARMANDER_ID}`,
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED", details: { fields: ["trainerName"] } },
    });
  });
});
