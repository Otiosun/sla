import { z } from "zod";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";

const uuidSchema = z.string().uuid();

export function validateRegistrationDraft(
  input: RegistrationDraftInput,
): Result<RegistrationSnapshot> {
  const normalized = {
    trainerName: input.trainerName.trim(),
    age: input.age,
    genderPronouns: input.genderPronouns.trim(),
    appearance: input.appearance.trim(),
    personality: input.personality.trim(),
    backstory: input.backstory.trim(),
    starterFormId: input.starterFormId,
    regionId: input.regionId,
    schemaVersion: input.schemaVersion,
  } satisfies RegistrationSnapshot;

  const invalidFields: string[] = [];

  if (normalized.trainerName.length === 0) invalidFields.push("trainerName");
  if (!Number.isInteger(normalized.age) || normalized.age <= 0) invalidFields.push("age");
  if (normalized.genderPronouns.length === 0) invalidFields.push("genderPronouns");
  if (normalized.appearance.length === 0) invalidFields.push("appearance");
  if (normalized.personality.length === 0) invalidFields.push("personality");
  if (normalized.backstory.length === 0) invalidFields.push("backstory");
  if (!uuidSchema.safeParse(normalized.starterFormId).success) invalidFields.push("starterFormId");
  if (!uuidSchema.safeParse(normalized.regionId).success) invalidFields.push("regionId");

  if (invalidFields.length > 0) {
    return err(
      appError("VALIDATION_FAILED", "Registration draft is invalid", { fields: invalidFields }),
    );
  }

  return ok(normalized);
}
