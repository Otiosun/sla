import { z } from "zod";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";

const uuidSchema = z.string().uuid();

function normalizedDraft(input: RegistrationDraftInput): RegistrationDraftInput {
  return {
    ...(input.trainerName === undefined ? {} : { trainerName: input.trainerName.trim() }),
    ...(input.age === undefined ? {} : { age: input.age }),
    ...(input.genderPronouns === undefined ? {} : { genderPronouns: input.genderPronouns.trim() }),
    ...(input.appearance === undefined ? {} : { appearance: input.appearance.trim() }),
    ...(input.personality === undefined ? {} : { personality: input.personality.trim() }),
    ...(input.backstory === undefined ? {} : { backstory: input.backstory.trim() }),
    ...(input.starterFormId === undefined ? {} : { starterFormId: input.starterFormId.trim() }),
    regionId: input.regionId.trim(),
    schemaVersion: input.schemaVersion,
  };
}

export function normalizeRegistrationDraft(
  input: RegistrationDraftInput,
): Result<RegistrationDraftInput> {
  const normalized = normalizedDraft(input);
  const invalidFields: string[] = [];

  if (normalized.trainerName !== undefined && normalized.trainerName.length === 0) {
    invalidFields.push("trainerName");
  }
  if (normalized.age !== undefined && (!Number.isInteger(normalized.age) || normalized.age <= 0)) {
    invalidFields.push("age");
  }
  if (normalized.genderPronouns !== undefined && normalized.genderPronouns.length === 0) {
    invalidFields.push("genderPronouns");
  }
  if (normalized.appearance !== undefined && normalized.appearance.length === 0) {
    invalidFields.push("appearance");
  }
  if (normalized.personality !== undefined && normalized.personality.length === 0) {
    invalidFields.push("personality");
  }
  if (normalized.backstory !== undefined && normalized.backstory.length === 0) {
    invalidFields.push("backstory");
  }
  if (
    normalized.starterFormId !== undefined &&
    !uuidSchema.safeParse(normalized.starterFormId).success
  ) {
    invalidFields.push("starterFormId");
  }
  if (!uuidSchema.safeParse(normalized.regionId).success) invalidFields.push("regionId");
  if (!Number.isInteger(normalized.schemaVersion) || normalized.schemaVersion <= 0) {
    invalidFields.push("schemaVersion");
  }

  if (invalidFields.length > 0) {
    return err(
      appError("VALIDATION_FAILED", "Registration draft is invalid", { fields: invalidFields }),
    );
  }

  return ok(normalized);
}

export function validateRegistrationDraft(
  input: RegistrationDraftInput,
): Result<RegistrationSnapshot> {
  const normalizedResult = normalizeRegistrationDraft(input);
  if (!normalizedResult.ok) return normalizedResult;
  const normalized = normalizedResult.value;
  const missingFields: string[] = [];

  if (normalized.trainerName === undefined) missingFields.push("trainerName");
  if (normalized.age === undefined) missingFields.push("age");
  if (normalized.genderPronouns === undefined) missingFields.push("genderPronouns");
  if (normalized.appearance === undefined) missingFields.push("appearance");
  if (normalized.personality === undefined) missingFields.push("personality");
  if (normalized.backstory === undefined) missingFields.push("backstory");
  if (normalized.starterFormId === undefined) missingFields.push("starterFormId");

  if (missingFields.length > 0) {
    return err(
      appError("VALIDATION_FAILED", "Registration draft is invalid", { fields: missingFields }),
    );
  }

  const { trainerName, age, genderPronouns, appearance, personality, backstory, starterFormId } =
    normalized;
  if (
    trainerName === undefined ||
    age === undefined ||
    genderPronouns === undefined ||
    appearance === undefined ||
    personality === undefined ||
    backstory === undefined ||
    starterFormId === undefined
  ) {
    return err(appError("VALIDATION_FAILED", "Registration draft is invalid"));
  }

  return ok({
    trainerName,
    age,
    genderPronouns,
    appearance,
    personality,
    backstory,
    starterFormId,
    regionId: normalized.regionId,
    schemaVersion: normalized.schemaVersion,
  });
}
