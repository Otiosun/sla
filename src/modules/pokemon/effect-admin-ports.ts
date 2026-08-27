import type { ApplyPokemonEffectInput, RemovePokemonEffectInput } from "./admin-contracts.js";
import type { PokemonAdminPersistenceResult } from "./admin-ports.js";

export interface PokemonEffectAdminRepository {
  applyEffect(input: ApplyPokemonEffectInput): Promise<PokemonAdminPersistenceResult>;
  removeEffect(input: RemovePokemonEffectInput): Promise<PokemonAdminPersistenceResult>;
}
