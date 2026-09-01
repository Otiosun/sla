import { describe, expect, it } from "vitest";
import { validateRegistrationDraft } from "../../src/modules/registration/validation.js";

const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_FORM_ID = "22222222-2222-4222-8222-222222222222";

describe("registration draft validation", () => {
  it("accepts a complete ficha and normalizes harmless surrounding whitespace", () => {
    const result = validateRegistrationDraft({
      trainerName: "  Liora Vale  ",
      age: 17,
      genderPronouns: "  ela/dela  ",
      appearance: "  Cabelos negros e casaco de viagem.  ",
      personality: "  Curiosa, cautelosa e competitiva.  ",
      backstory: "  Saiu de casa para pesquisar Pokémon raros.  ",
      starterFormId: STARTER_FORM_ID,
      regionId: REGION_ID,
      schemaVersion: 1,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        appearance: "Cabelos negros e casaco de viagem.",
        personality: "Curiosa, cautelosa e competitiva.",
        backstory: "Saiu de casa para pesquisar Pokémon raros.",
        starterFormId: STARTER_FORM_ID,
        regionId: REGION_ID,
        schemaVersion: 1,
      },
    });
  });
});
