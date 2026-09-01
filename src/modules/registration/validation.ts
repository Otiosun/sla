import { ok, type Result } from "../../shared-kernel/result.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";

export function validateRegistrationDraft(
  input: RegistrationDraftInput,
): Result<RegistrationSnapshot> {
  return ok({
    trainerName: input.trainerName.trim(),
    age: input.age,
    genderPronouns: input.genderPronouns.trim(),
    appearance: input.appearance.trim(),
    personality: input.personality.trim(),
    backstory: input.backstory.trim(),
    starterFormId: input.starterFormId,
    regionId: input.regionId,
    schemaVersion: input.schemaVersion,
  });
}
