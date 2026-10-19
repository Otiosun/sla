import { EntitlementGrantInputSchema, type EntitlementGrantResult } from "./contracts.js";
import type { EntitlementRepository } from "./ports.js";

export class EntitlementService {
  public constructor(private readonly repository: EntitlementRepository) {}

  public async grant(rawInput: unknown): Promise<EntitlementGrantResult> {
    const input = EntitlementGrantInputSchema.parse(rawInput);
    return this.repository.grant(input);
  }

  public async listPlayerEntitlements(playerId: string) {
    return this.repository.listPlayerEntitlements(playerId);
  }
}
