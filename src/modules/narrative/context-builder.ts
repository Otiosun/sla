import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  NarrativeContextInputSchema,
  NarrativeProviderContextSchema,
  type NarrativeContextInput,
  type NarrativeProviderContext,
} from "./contracts.js";

export class NarrativeContextBuilder {
  public build(input: NarrativeContextInput): Result<NarrativeProviderContext> {
    const parsed = NarrativeContextInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        appError("VALIDATION_FAILED", "Narrative context input is invalid", {
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
        }),
      );
    }

    const value = NarrativeProviderContextSchema.parse({
      schemaVersion: "narrative-context.v1",
      sceneId: parsed.data.sceneId,
      actorId: parsed.data.actorId,
      userText: parsed.data.userText,
      state: parsed.data.state,
      legalActions: parsed.data.legalActions,
    });
    return ok(value);
  }
}
