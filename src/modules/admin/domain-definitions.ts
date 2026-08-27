import {
  AdminInventoryAdjustInputSchema,
  AdminPokemonArchiveInputSchema,
  AdminPokemonHpCorrectInputSchema,
  AdminPokemonRosterMoveInputSchema,
  AdminPokemonStatusCorrectInputSchema,
  AdminTrainerProgressAdjustInputSchema,
  type AdminInventoryAdjustInput,
  type AdminPokemonArchiveInput,
  type AdminPokemonHpCorrectInput,
  type AdminPokemonRosterMoveInput,
  type AdminPokemonStatusCorrectInput,
  type AdminTrainerProgressAdjustInput,
  AdminWalletAdjustInputSchema,
  type AdminWalletAdjustInput,
} from "./domain-contracts.js";
import type { AdminDomainOperationPort } from "./domain-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const deltaPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const rosterMutationPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const pokemonMechanicalPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

export function registerPhase12CDomainAdminOperations(
  registry: AdminOperationRegistry,
  port: AdminDomainOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminInventoryAdjustInput>({
      kind: "MUTATION",
      operationType: "inventory.adjust",
      capabilityKey: "inventory.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: deltaPolicy,
      inputSchema: AdminInventoryAdjustInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyInventoryAdjustment(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminTrainerProgressAdjustInput>({
      kind: "MUTATION",
      operationType: "progression.trainer.adjust",
      capabilityKey: "progression.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: deltaPolicy,
      inputSchema: AdminTrainerProgressAdjustInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyTrainerProgressAdjustment(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminWalletAdjustInput>({
      kind: "MUTATION",
      operationType: "wallet.adjust",
      capabilityKey: "wallet.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: deltaPolicy,
      inputSchema: AdminWalletAdjustInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyWalletAdjustment(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminPokemonRosterMoveInput>({
      kind: "MUTATION",
      operationType: "pokemon.roster.move",
      capabilityKey: "pokemon.roster.manage",
      riskTier: 1,
      authorizationMode: "SUBJECT",
      policy: rosterMutationPolicy,
      inputSchema: AdminPokemonRosterMoveInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyPokemonRosterMove(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminPokemonHpCorrectInput>({
      kind: "MUTATION",
      operationType: "pokemon.hp.correct",
      capabilityKey: "pokemon.edit.mechanics",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: pokemonMechanicalPolicy,
      inputSchema: AdminPokemonHpCorrectInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyPokemonHpCorrection(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminPokemonStatusCorrectInput>({
      kind: "MUTATION",
      operationType: "pokemon.status.correct",
      capabilityKey: "pokemon.edit.mechanics",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: pokemonMechanicalPolicy,
      inputSchema: AdminPokemonStatusCorrectInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyPokemonStatusCorrection(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminPokemonArchiveInput>({
      kind: "MUTATION",
      operationType: "pokemon.archive",
      capabilityKey: "pokemon.archive_remove",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: pokemonMechanicalPolicy,
      inputSchema: AdminPokemonArchiveInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyPokemonArchive(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
