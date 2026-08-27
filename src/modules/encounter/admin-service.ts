import type {
  EncounterAdminCloseInput,
  EncounterAdminCloseResult,
  EncounterAdminState,
} from "./admin-contracts.js";
import type { EncounterAdminRepository } from "./admin-ports.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export class EncounterAdminOwnerService {
  public constructor(private readonly repository: EncounterAdminRepository) {}

  public async inspect(
    playerId: EncounterAdminCloseInput["playerId"],
    encounterId: EncounterAdminCloseInput["encounterId"],
  ): Promise<Result<EncounterAdminState>> {
    const state = await this.repository.inspect(playerId, encounterId);
    return state === null
      ? err(appError("NOT_FOUND", "Encounter administrative target was not found"))
      : ok(state);
  }

  public async close(input: EncounterAdminCloseInput): Promise<Result<EncounterAdminCloseResult>> {
    const persisted = await this.repository.close(input);
    switch (persisted.kind) {
      case "APPLIED":
        return ok(persisted.result);
      case "REPLAYED":
        return ok({ ...persisted.result, replayed: true });
      case "NOT_FOUND":
        return err(appError("NOT_FOUND", "Encounter administrative target was not found"));
      case "REVISION_CONFLICT":
        return err(
          appError("REVISION_CONFLICT", "Encounter revision changed", {
            actualRevision: persisted.actualRevision.toString(),
          }),
        );
      case "UNSAFE_FLOW":
        return err(appError("INVALID_STATE_TRANSITION", persisted.reason));
      case "INVALID_STATE":
        return err(appError("ACTION_INVALID", persisted.reason));
      case "IDEMPOTENCY_CONFLICT":
        return err(
          appError(
            "FINGERPRINT_MISMATCH",
            "Encounter admin idempotency key is bound to another request",
          ),
        );
    }
  }
}
