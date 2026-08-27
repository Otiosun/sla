import type { AdminOperationRecord } from "./contracts.js";
import type {
  AdminInventoryAdjustInput,
  AdminPokemonArchiveInput,
  AdminPokemonCreateInput,
  AdminPokemonEffectApplyInput,
  AdminPokemonEffectRemoveInput,
  AdminPokemonHpCorrectInput,
  AdminPokemonProgressCorrectInput,
  AdminPokemonRosterMoveInput,
  AdminPokemonStatusCorrectInput,
  AdminTrainerProgressAdjustInput,
  AdminWalletAdjustInput,
} from "./domain-contracts.js";

export interface AdminDomainOperationPort {
  applyInventoryAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminInventoryAdjustInput,
  ): Promise<AdminOperationRecord>;
  applyTrainerProgressAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminTrainerProgressAdjustInput,
  ): Promise<AdminOperationRecord>;
  applyWalletAdjustment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminWalletAdjustInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonCreate(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonCreateInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonRosterMove(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonRosterMoveInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonProgressCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonProgressCorrectInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonHpCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonHpCorrectInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonStatusCorrection(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonStatusCorrectInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonEffect(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonEffectApplyInput,
  ): Promise<AdminOperationRecord>;
  removePokemonEffect(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonEffectRemoveInput,
  ): Promise<AdminOperationRecord>;
  applyPokemonArchive(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminPokemonArchiveInput,
  ): Promise<AdminOperationRecord>;
}
