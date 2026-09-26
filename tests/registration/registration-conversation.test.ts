import { describe, expect, it } from "vitest";
import {
  looksLikeFullRegistrationTemplate,
  parseFullRegistrationTemplate,
  parsePartialRegistrationTemplate,
  parseRegistrationModeChoice,
  RegistrationConversationSessions,
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
    profession: "PESQUISADOR",
    starterFormId: CHARMANDER_ID,
    regionId: ZHOULIA_ID,
    schemaVersion: 1,
  } as const;
}

describe("RegistrationConversationSessions", () => {
  it("begins without choosing guided or full mode for the player", () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();

    expect(sessions.begin(playerId, { regionId: ZHOULIA_ID })).toMatchObject({
      playerId,
      mode: "CHOOSING",
      currentField: null,
      dirty: false,
      working: { regionId: ZHOULIA_ID, schemaVersion: 1 },
    });
  });

  it("accepts explicit mode choice and rejects invalid choices without mutating the session", () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();
    sessions.begin(playerId, { regionId: ZHOULIA_ID });

    expect(sessions.chooseMode(playerId, "3")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(sessions.get(playerId)).toMatchObject({ mode: "CHOOSING", currentField: null });

    expect(sessions.chooseMode(playerId, "1")).toMatchObject({
      ok: true,
      value: { mode: "GUIDED", currentField: "trainerName" },
    });

    const secondPlayer = createPlayerId();
    sessions.begin(secondPlayer, { regionId: ZHOULIA_ID, baseDraft: completedDraft() });
    expect(sessions.chooseMode(secondPlayer, "2")).toMatchObject({
      ok: true,
      value: { mode: "FULL", currentField: null, working: { trainerName: "Liora Vale" } },
    });
  });

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

  it("tracks the persisted draft revision separately from unsaved working edits", () => {
    const playerId = createPlayerId();
    const sessions = new RegistrationConversationSessions();

    const resumed = sessions.start(playerId, {
      mode: "GUIDED",
      regionId: ZHOULIA_ID,
      baseDraft: { trainerName: "Liora Vale", regionId: ZHOULIA_ID, schemaVersion: 1 },
      baseRevision: 3,
    });

    expect(resumed).toMatchObject({
      persistedRevision: 3,
      dirty: false,
      currentField: "age",
    });

    const changed = sessions.applyGuidedAnswer(playerId, "17");
    expect(changed).toMatchObject({
      ok: true,
      value: { persistedRevision: 3, dirty: true, currentField: "genderPronouns" },
    });
  });

  it("accepts human mode variants used in the real Reception", () => {
    expect(parseRegistrationModeChoice("01")).toBe("GUIDED");
    expect(parseRegistrationModeChoice("/02")).toBe("FULL");
    expect(parseRegistrationModeChoice("#2")).toBe("FULL");
    expect(parseRegistrationModeChoice("quero o 2")).toBe("FULL");
    expect(parseRegistrationModeChoice("vou de modo guiado")).toBeNull();
  });

  it("parses partial full forms without inventing omitted flexible fields", () => {
    const parsed = parsePartialRegistrationTemplate(
      ["Nome: Emi", "Idade: 17", "Gênero / pronomes: ela/dela", "Personalidade: curiosa"].join(
        "\n",
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        trainerName: "Emi",
        age: 17,
        genderPronouns: "ela/dela",
        personality: "curiosa",
      },
    });
  });

  it("treats Appearance and História as optional in a complete form", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        "Nome: Emi",
        "Idade: 17",
        "Gênero / pronomes: ela/dela",
        "Personalidade: curiosa",
        "Pokémon inicial: 02",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        trainerName: "Emi",
        appearance: "—",
        backstory: "—",
        starterFormId: "02",
      },
    });
  });

  it("parses an optional profession without making it required", () => {
    const withProfession = parseFullRegistrationTemplate(
      [
        "Nome: Emi",
        "Idade: 17",
        "Gênero / pronomes: ela/dela",
        "Personalidade: curiosa",
        "Profissão: Artesão",
        "Pokémon inicial: 02",
      ].join("\n"),
    );
    expect(withProfession).toMatchObject({
      ok: true,
      value: { profession: "ARTESAO", starterFormId: "02" },
    });

    const invalid = parsePartialRegistrationTemplate("Profissão: astronauta");
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED", details: { fields: ["profession"] } },
    });
  });

  it("recognizes a filled full-form shape without treating ordinary chat as registration", () => {
    expect(
      looksLikeFullRegistrationTemplate(
        [
          "Nome: Liora Vale",
          "Idade: 17",
          "Pronomes: ela/dela",
          "Aparência: Casaco escuro.",
          "Personalidade: Curiosa.",
          "História: Uma história curta.",
          "Inicial: 1",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(looksLikeFullRegistrationTemplate("Tá, ótimo sinal")).toBe(false);
    expect(looksLikeFullRegistrationTemplate("Nome: Liora\nIdade: 17")).toBe(false);
  });

  it("ignores WhatsApp bold decoration around full-form labels", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        "*Nome:* Liora Vale",
        "*Idade:* 17",
        "*Gênero / pronomes:* ela/dela",
        "*Aparência:* Cabelos negros.",
        "*Personalidade:* Curiosa.",
        "*História:* Saiu de casa para explorar Zhoulia.",
        "*Pokémon inicial:* 02",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        starterFormId: "02",
      },
    });
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

  it("accumulates multiline full-form content until the next recognized field header", () => {
    const parsed = parseFullRegistrationTemplate(
      [
        "Nome: Liora Vale",
        "Idade: 17",
        "Pronomes: ela/dela",
        "Aparência: Cabelos negros.",
        "Usa um casaco de viagem.",
        "Carrega uma mochila pequena.",
        "Personalidade:",
        "Curiosa e competitiva.",
        "Cautelosa quando não conhece o lugar.",
        "História: Saiu de casa para pesquisar Pokémon raros.",
        "Passou um ano ajudando no laboratório da cidade.",
        `Inicial: ${SQUIRTLE_ID}`,
      ].join("\n"),
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        appearance: [
          "Cabelos negros.",
          "Usa um casaco de viagem.",
          "Carrega uma mochila pequena.",
        ].join("\n"),
        personality: ["Curiosa e competitiva.", "Cautelosa quando não conhece o lugar."].join("\n"),
        backstory: [
          "Saiu de casa para pesquisar Pokémon raros.",
          "Passou um ano ajudando no laboratório da cidade.",
        ].join("\n"),
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
