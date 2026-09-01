import { describe, expect, it } from "vitest";
import { validateRegistrationDraft } from "../../src/modules/registration/validation.js";

const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_FORM_ID = "22222222-2222-4222-8222-222222222222";

const completeDraft = {
  trainerName: "Liora Vale",
  age: 17,
  genderPronouns: "ela/dela",
  appearance: "Cabelos negros e casaco de viagem.",
  personality: "Curiosa, cautelosa e competitiva.",
  backstory: "Saiu de casa para pesquisar Pokémon raros.",
  starterFormId: STARTER_FORM_ID,
  regionId: REGION_ID,
  schemaVersion: 1,
} as const;

describe("registration draft validation", () => {
  it("accepts a complete ficha and normalizes harmless surrounding whitespace", () => {
    const result = validateRegistrationDraft({
      ...completeDraft,
      trainerName: "  Liora Vale  ",
      genderPronouns: "  ela/dela  ",
      appearance: "  Cabelos negros e casaco de viagem.  ",
      personality: "  Curiosa, cautelosa e competitiva.  ",
      backstory: "  Saiu de casa para pesquisar Pokémon raros.  ",
    });

    expect(result).toEqual({ ok: true, value: completeDraft });
  });

  it("rejects a blank required text field instead of inventing a value", () => {
    const result = validateRegistrationDraft({
      ...completeDraft,
      appearance: "   ",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Registration draft is invalid",
        details: { fields: ["appearance"] },
      },
    });
  });

  it("rejects non-integer or non-positive age", () => {
    for (const age of [0, -1, 17.5, Number.NaN]) {
      const result = validateRegistrationDraft({ ...completeDraft, age });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_FAILED");
        expect(result.error.details).toEqual({ fields: ["age"] });
      }
    }
  });

  it("rejects invalid starter and region identifiers", () => {
    const result = validateRegistrationDraft({
      ...completeDraft,
      starterFormId: "starter-charmander",
      regionId: "zhoulia",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Registration draft is invalid",
        details: { fields: ["starterFormId", "regionId"] },
      },
    });
  });
});
