import type { Clock } from "../../platform/clock/index.js";
import { CounterRandomSource } from "../../platform/rng/counter-rng.js";
import {
  evaluateActionGate,
  type FeatureAvailability,
  type PlayerEligibility,
} from "../../shared-kernel/gates.js";
import {
  createBattleId,
  createEncounterId,
  type EncounterId,
  type PlayerId,
} from "../../shared-kernel/ids.js";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import { err, ok, type Result } from "../../shared-kernel/result.js";
import { encounterConditionsAllow } from "../catalog/encounter-contracts.js";
import type {
  CreateEncounterInput,
  EncounterMutationInput,
  EncounterPlayerContext,
  EncounterRecord,
  EncounterStatus,
  EncounterView,
  ExpireResult,
  StartBattleResult,
} from "./contracts.js";
import {
  encounterNotFound,
  encounterNotReady,
  encounterRevisionConflict,
  encounterValidationError,
} from "./errors.js";
import {
  chooseEncounterLevel,
  chooseWeightedEncounterEntry,
  generateWildPokemon,
} from "./generation.js";
import { resolveEncounterRulesetPolicy } from "./policy.js";
import type { EncounterRepository, EncounterSeedProvider, EncounterTransaction } from "./ports.js";
import { encounterStateMachine } from "./state.js";

const encounterCreateScopeResult = parseIdempotencyScope("encounter.create");
if (!encounterCreateScopeResult.ok)
  throw new Error("Canonical encounter idempotency scope is invalid");
const ENCOUNTER_CREATE_SCOPE = encounterCreateScopeResult.value;
const TABLE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function playerGate(context: EncounterPlayerContext): PlayerEligibility {
  if (!context.playerActive) return { eligible: false, reason: "player-not-active" };
  if (!context.onboardingComplete) return { eligible: false, reason: "onboarding-incomplete" };
  return { eligible: true, reason: null };
}

function validateExpectedRevision(expectedRevision: bigint): Result<void> {
  return expectedRevision < 0n
    ? err(encounterValidationError("expectedRevision must be non-negative"))
    : ok(undefined);
}

export class EncounterService {
  public constructor(
    private readonly repository: EncounterRepository,
    private readonly seedProvider: EncounterSeedProvider,
    private readonly clock: Clock,
    private readonly feature: FeatureAvailability,
  ) {}

  public async createOrReplay(input: CreateEncounterInput): Promise<Result<EncounterView>> {
    if (
      input.encounterTableSlug !== undefined &&
      !TABLE_SLUG_PATTERN.test(input.encounterTableSlug)
    ) {
      return err(encounterValidationError("encounterTableSlug has an invalid format"));
    }
    const idempotency = createIdempotencyKey(ENCOUNTER_CREATE_SCOPE, input.idempotencyKey);
    if (!idempotency.ok) return idempotency;

    return this.repository.transaction(async (transaction) => {
      const context = await transaction.playerContext(input.playerId, true);
      if (context === null) return err(encounterNotFound("Player was not found"));

      const replay = await transaction.byCreationKey(
        input.playerId,
        idempotency.value.storageKey,
        true,
      );
      if (replay !== null) return this.buildView(transaction, replay);

      const activeEncounter = await transaction.activeForPlayer(input.playerId, true);
      if (activeEncounter !== null) {
        return err(encounterNotReady("Player already has an incompatible active encounter"));
      }

      const content = await transaction.activeContent();
      if (content === null) return err(encounterNotReady("No active content release exists"));
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(context),
        flow: {
          state: context.activeBattle ? "BATTLE_ACTIVE" : "FREE",
          allowsAction: !context.activeBattle,
          reason: context.activeBattle ? "active-battle" : null,
        },
        action: {
          valid: context.areaId !== null,
          reason: context.areaId === null ? "player-location-missing" : null,
        },
      });
      if (!gate.ok) return gate;
      if (context.areaId === null) return err(encounterNotReady("Player location is missing"));

      const unlocks = new Set(context.unlockKeys);
      const allTables = await transaction.tables(content.contentReleaseId, context.areaId);
      const eligibleTables = allTables.filter(
        (table) =>
          table.active &&
          encounterConditionsAllow(table.conditions, unlocks) &&
          (input.encounterTableSlug === undefined || table.slug === input.encounterTableSlug),
      );
      if (eligibleTables.length === 0) {
        return err(encounterNotReady("No eligible encounter table exists for the current area"));
      }
      if (eligibleTables.length > 1 && input.encounterTableSlug === undefined) {
        return err(
          encounterNotReady(
            "Multiple encounter tables are eligible; an explicit encounterTableSlug is required",
          ),
        );
      }
      const table = eligibleTables[0];
      if (table === undefined)
        return err(encounterNotReady("Encounter table could not be resolved"));
      const entries = table.entries.filter(
        (entry) => entry.active && encounterConditionsAllow(entry.conditions, unlocks),
      );
      if (entries.length === 0) {
        return err(encounterNotReady("Encounter table has no eligible active entries"));
      }

      const encounterId = createEncounterId();
      const seedMaterial = this.seedProvider.create(`encounter:${encounterId}`);
      const rng = new CounterRandomSource(seedMaterial.seed);
      const entry = chooseWeightedEncounterEntry(entries, rng);
      const level = chooseEncounterLevel(entry, rng);
      const build = await transaction.wildBuild(content.contentReleaseId, entry.formId);
      if (build === null) {
        return err(encounterNotReady("Encounter entry references unavailable Pokemon content"));
      }
      const snapshot = generateWildPokemon(build, level, rng);
      const policy = resolveEncounterRulesetPolicy(content.rulesetConfig);
      const createdAt = this.clock.now();
      const expiresAt = new Date(createdAt.getTime() + policy.expirationSeconds * 1_000);
      const record = await transaction.insertEncounter({
        encounterId,
        playerId: input.playerId,
        areaId: context.areaId,
        contentReleaseId: content.contentReleaseId,
        rulesetId: content.rulesetId,
        creationIdempotencyKey: idempotency.value.storageKey,
        seed: seedMaterial.envelope,
        rngCounter: rng.counter,
        createdAt,
        expiresAt,
        snapshot,
      });
      return this.buildView(transaction, record);
    });
  }

  public async get(playerId: PlayerId, encounterId: EncounterId): Promise<Result<EncounterView>> {
    return this.repository.read(async (transaction) => {
      const record = await transaction.byId(playerId, encounterId);
      if (record === null) return err(encounterNotFound());
      return this.buildView(transaction, record);
    });
  }

  public async observe(input: EncounterMutationInput): Promise<Result<EncounterView>> {
    const revision = validateExpectedRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    return this.repository.transaction(async (transaction) => {
      const record = await transaction.byId(input.playerId, input.encounterId, true);
      if (record === null) return err(encounterNotFound());
      if (record.status !== "CREATED") return this.buildView(transaction, record);
      if (record.revision !== input.expectedRevision) {
        return err(encounterRevisionConflict(input.expectedRevision));
      }
      const moved = await this.transition(
        transaction,
        record,
        "PRESENTED",
        input.expectedRevision,
        null,
      );
      if (!moved.ok) return moved;
      return this.buildView(transaction, moved.value);
    });
  }

  public async engage(input: EncounterMutationInput): Promise<Result<EncounterView>> {
    return this.mutateActive(input, "PRESENTED", "ENGAGED", false);
  }

  public async flee(input: EncounterMutationInput): Promise<Result<EncounterView>> {
    const revision = validateExpectedRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    return this.repository.transaction(async (transaction) => {
      const record = await transaction.byId(input.playerId, input.encounterId, true);
      if (record === null) return err(encounterNotFound());
      if (record.status === "FLED") return this.buildView(transaction, record);
      if (!(["CREATED", "PRESENTED", "ENGAGED"] as EncounterStatus[]).includes(record.status)) {
        return err(encounterNotReady("Encounter cannot be fled from its current state"));
      }
      if (record.revision !== input.expectedRevision) {
        return err(encounterRevisionConflict(input.expectedRevision));
      }
      const context = await transaction.playerContext(input.playerId);
      if (context === null) return err(encounterNotFound("Player was not found"));
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(context),
        flow: { state: "ENCOUNTER_ACTIVE", allowsAction: true, reason: null },
        action: { valid: true, reason: null },
      });
      if (!gate.ok) return gate;
      const moved = await this.transition(
        transaction,
        record,
        "FLED",
        input.expectedRevision,
        this.clock.now(),
      );
      if (!moved.ok) return moved;
      return this.buildView(transaction, moved.value);
    });
  }

  public async startBattle(input: EncounterMutationInput): Promise<Result<StartBattleResult>> {
    const revision = validateExpectedRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    return this.repository.transaction(async (transaction) => {
      const record = await transaction.byId(input.playerId, input.encounterId, true);
      if (record === null) return err(encounterNotFound());
      if (record.status === "IN_BATTLE") {
        const battleId = await transaction.battleId(record.encounterId);
        if (battleId === null) return err(encounterNotReady("Encounter battle link is missing"));
        const view = await this.buildView(transaction, record);
        return view.ok ? ok({ encounter: view.value, battleId, replayed: true }) : view;
      }
      if (record.status !== "ENGAGED") {
        return err(encounterNotReady("Battle can start only from an engaged encounter"));
      }
      if (record.revision !== input.expectedRevision) {
        return err(encounterRevisionConflict(input.expectedRevision));
      }
      const context = await transaction.playerContext(input.playerId);
      if (context === null) return err(encounterNotFound("Player was not found"));
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(context),
        flow: {
          state: context.activeBattle ? "BATTLE_ACTIVE" : "ENCOUNTER_ACTIVE",
          allowsAction: !context.activeBattle,
          reason: context.activeBattle ? "active-battle" : null,
        },
        action: { valid: true, reason: null },
      });
      if (!gate.ok) return gate;

      const requestedBattleId = createBattleId();
      const battleSeed = this.seedProvider.create(`battle:${requestedBattleId}`);
      const moved = await this.transition(
        transaction,
        record,
        "IN_BATTLE",
        input.expectedRevision,
        null,
      );
      if (!moved.ok) return moved;
      const battleId = await transaction.createBattle({
        battleId: requestedBattleId,
        encounter: moved.value,
        seed: battleSeed.envelope,
      });
      const view = await this.buildView(transaction, moved.value);
      return view.ok ? ok({ encounter: view.value, battleId, replayed: false }) : view;
    });
  }

  public async beginCapture(input: EncounterMutationInput): Promise<Result<EncounterView>> {
    const revision = validateExpectedRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    return this.repository.transaction(async (transaction) => {
      const record = await transaction.byId(input.playerId, input.encounterId, true);
      if (record === null) return err(encounterNotFound());
      if (record.status === "CAPTURE_RESOLVING") return this.buildView(transaction, record);
      if (record.revision !== input.expectedRevision) {
        return err(encounterRevisionConflict(input.expectedRevision));
      }
      if (record.status !== "ENGAGED" && record.status !== "IN_BATTLE") {
        return err(encounterNotReady("Capture cannot start from the current encounter state"));
      }
      const rulesetConfig = await transaction.rulesetConfig(record.rulesetId);
      if (rulesetConfig === null)
        return err(encounterNotReady("Pinned encounter ruleset is missing"));
      const policy = resolveEncounterRulesetPolicy(rulesetConfig);
      if (!policy.captureAllowedStates.includes(record.status)) {
        return err(encounterNotReady("Capture is not allowed from the current encounter state"));
      }
      const context = await transaction.playerContext(input.playerId);
      if (context === null) return err(encounterNotFound("Player was not found"));
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(context),
        flow: { state: record.status, allowsAction: true, reason: null },
        action: { valid: true, reason: null },
      });
      if (!gate.ok) return gate;
      const moved = await this.transition(
        transaction,
        record,
        "CAPTURE_RESOLVING",
        input.expectedRevision,
        null,
      );
      if (!moved.ok) return moved;
      return this.buildView(transaction, moved.value);
    });
  }

  public async expireDue(limit = 100): Promise<Result<ExpireResult>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return err(encounterValidationError("expiration cleanup limit must be an integer in 1..500"));
    }
    return this.repository.transaction(async (transaction) =>
      ok({ expiredEncounterIds: await transaction.expireDue(this.clock.now(), limit) }),
    );
  }

  private async mutateActive(
    input: EncounterMutationInput,
    fromStatus: EncounterStatus,
    toStatus: EncounterStatus,
    closes: boolean,
  ): Promise<Result<EncounterView>> {
    const revision = validateExpectedRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    return this.repository.transaction(async (transaction) => {
      const record = await transaction.byId(input.playerId, input.encounterId, true);
      if (record === null) return err(encounterNotFound());
      if (record.status === toStatus) return this.buildView(transaction, record);
      if (record.status !== fromStatus) {
        return err(encounterNotReady(`Encounter must be ${fromStatus} before ${toStatus}`));
      }
      if (record.revision !== input.expectedRevision) {
        return err(encounterRevisionConflict(input.expectedRevision));
      }
      const context = await transaction.playerContext(input.playerId);
      if (context === null) return err(encounterNotFound("Player was not found"));
      const gate = evaluateActionGate({
        feature: this.feature,
        player: playerGate(context),
        flow: { state: "ENCOUNTER_ACTIVE", allowsAction: true, reason: null },
        action: { valid: true, reason: null },
      });
      if (!gate.ok) return gate;
      const moved = await this.transition(
        transaction,
        record,
        toStatus,
        input.expectedRevision,
        closes ? this.clock.now() : null,
      );
      if (!moved.ok) return moved;
      return this.buildView(transaction, moved.value);
    });
  }

  private async transition(
    transaction: EncounterTransaction,
    record: EncounterRecord,
    toStatus: EncounterStatus,
    expectedRevision: bigint,
    closedAt: Date | null,
  ): Promise<Result<EncounterRecord>> {
    const state = encounterStateMachine.transition(record.status, toStatus);
    if (!state.ok) return state;
    const moved = await transaction.transition({
      playerId: record.playerId,
      encounterId: record.encounterId,
      fromStatus: record.status,
      toStatus,
      expectedRevision,
      closedAt,
    });
    return moved === null ? err(encounterRevisionConflict(expectedRevision)) : ok(moved);
  }

  private async buildView(
    transaction: EncounterTransaction,
    record: EncounterRecord,
  ): Promise<Result<EncounterView>> {
    const snapshot = await transaction.snapshot(record.encounterId);
    if (snapshot === null) return err(encounterNotReady("Encounter snapshot is missing"));
    return ok({
      ...record,
      snapshot,
      battleId: await transaction.battleId(record.encounterId),
    });
  }
}
