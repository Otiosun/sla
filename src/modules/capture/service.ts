import { createHash, randomUUID } from "node:crypto";
import { CounterRandomSource } from "../../platform/rng/counter-rng.js";
import { createPokemonInstanceId } from "../../shared-kernel/ids.js";
import { createIdempotencyKey, parseIdempotencyScope } from "../../shared-kernel/idempotency.js";
import { err, ok, type AppError, type Result } from "../../shared-kernel/result.js";
import type { BattleCombatant } from "../battle/contracts.js";
import { EffectConfigSchemas, RulesetConfigSchema } from "../catalog/contracts.js";
import {
  CaptureAttemptInputBoundarySchema,
  CaptureProbabilityInputSchema,
  type CapturedPokemonState,
  type CaptureAttemptInput,
  type CaptureAttemptRecord,
  type CaptureAttemptResult,
  type CaptureContext,
  type CaptureDomainEvent,
} from "./contracts.js";
import {
  captureBattleVersionConflict,
  captureIdempotencyMismatch,
  captureInsufficientBall,
  captureIntegrityError,
  captureNotFound,
  captureNotReady,
  captureRevisionConflict,
  captureValidationError,
} from "./errors.js";
import type { CaptureRepository, CaptureSeedProvider } from "./ports.js";
import { captureProbability } from "./probability.js";

const scope = parseIdempotencyScope("capture.attempt");
if (!scope.ok) throw new Error("Canonical capture idempotency scope is invalid");
const CAPTURE_ATTEMPT_SCOPE = scope.value;

class CaptureRollback extends Error {
  public constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = "CaptureRollback";
  }
}

function rollback(error: AppError): never {
  throw new CaptureRollback(error);
}

function sortedModifiers(input: CaptureAttemptInput): readonly number[] {
  return [...(input.explicitModifierBasisPoints ?? [])].sort((left, right) => left - right);
}

function semanticFingerprint(input: CaptureAttemptInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        playerId: input.playerId,
        encounterId: input.encounterId,
        ballItemId: input.ballItemId,
        explicitModifierBasisPoints: sortedModifiers(input),
      }),
    )
    .digest("hex");
}

function resultEvents(record: {
  readonly id: string;
  readonly encounterId: string;
  readonly battleId: string | null;
  readonly status: "FAILED" | "CAPTURED";
  readonly probabilityBasisPoints: number;
  readonly rollBasisPoints: number;
  readonly pokemonInstanceId: string | null;
}): readonly CaptureDomainEvent[] {
  const events: CaptureDomainEvent[] = [
    {
      type: "CaptureAttemptResolved",
      payload: {
        captureAttemptId: record.id,
        encounterId: record.encounterId,
        battleId: record.battleId,
        status: record.status,
        probabilityBasisPoints: record.probabilityBasisPoints,
        rollBasisPoints: record.rollBasisPoints,
      },
    },
  ];
  if (record.status === "CAPTURED" && record.pokemonInstanceId !== null) {
    events.push({
      type: "PokemonCaptured",
      payload: {
        captureAttemptId: record.id,
        encounterId: record.encounterId,
        pokemonInstanceId: record.pokemonInstanceId,
      },
    });
  }
  return events;
}

function replay(record: CaptureAttemptRecord, fingerprint: string): Result<CaptureAttemptResult> {
  if (record.requestFingerprint !== fingerprint) return err(captureIdempotencyMismatch());
  if (record.status === "PENDING" || record.resolvedAt === null) {
    return err(captureIntegrityError("Capture attempt exists without a durable final result"));
  }
  const status = record.status;
  return ok({
    captureAttemptId: record.id,
    encounterId: record.encounterId,
    battleId: record.battleId,
    status,
    probabilityBasisPoints: record.probabilityBasisPoints,
    rollBasisPoints: record.rollBasisPoints,
    pokemonInstanceId: record.pokemonInstanceId,
    placement: record.placement,
    events: resultEvents({
      id: record.id,
      encounterId: record.encounterId,
      battleId: record.battleId,
      status,
      probabilityBasisPoints: record.probabilityBasisPoints,
      rollBasisPoints: record.rollBasisPoints,
      pokemonInstanceId: record.pokemonInstanceId,
    }),
    replayed: true,
  });
}

function battleWild(context: CaptureContext): Result<BattleCombatant> {
  const state = context.battleState;
  if (state === null || context.battleId === null) {
    return err(captureNotReady("Encounter claims an active battle without a battle snapshot"));
  }
  if (
    state.status !== "ACTIVE" ||
    state.battleType !== "WILD" ||
    state.battleId !== context.battleId ||
    state.encounterId !== context.encounterId
  ) {
    return err(captureNotReady("Pinned battle is not an active wild battle for this encounter"));
  }
  const wild = state.combatants.filter((entry) => entry.participantKind === "WILD_POKEMON");
  if (wild.length !== 1 || wild[0] === undefined) {
    return err(captureNotReady("Wild battle must contain exactly one capturable wild combatant"));
  }
  if (wild[0].currentHp <= 0)
    return err(captureNotReady("A fainted wild Pokemon cannot be captured"));
  return ok(wild[0]);
}

function capturedState(context: CaptureContext): Result<CapturedPokemonState> {
  if (context.sourceStatus === "ENGAGED") {
    return ok({
      currentHp: context.encounterSnapshot.currentHp,
      majorStatus: null,
      moves: context.encounterSnapshot.moves.map((move) => ({ ...move })),
    });
  }
  const wild = battleWild(context);
  if (!wild.ok) return wild;
  return ok({
    currentHp: wild.value.currentHp,
    majorStatus: wild.value.majorStatus?.key ?? null,
    moves: context.encounterSnapshot.moves.map((source) => {
      const live = wild.value.moves.find((move) => move.moveId === source.moveId);
      return { moveId: source.moveId, ppCurrent: live?.ppCurrent ?? source.ppCurrent };
    }),
  });
}

export class CaptureService {
  public constructor(
    private readonly repository: CaptureRepository,
    private readonly seedProvider: CaptureSeedProvider,
  ) {}

  public async attempt(input: CaptureAttemptInput): Promise<Result<CaptureAttemptResult>> {
    const boundary = CaptureAttemptInputBoundarySchema.safeParse(input);
    if (!boundary.success) {
      return err(
        captureValidationError("Capture request is invalid", { issues: boundary.error.issues }),
      );
    }
    const modifiers = sortedModifiers(input);
    const idempotency = createIdempotencyKey(
      CAPTURE_ATTEMPT_SCOPE,
      `${input.playerId}:${input.idempotencyKey.trim()}`,
    );
    if (!idempotency.ok) return idempotency;
    const fingerprint = semanticFingerprint(input);

    try {
      return await this.repository.transaction(async (transaction) => {
        const existing = await transaction.findAttempt(idempotency.value.storageKey);
        if (existing !== null) return replay(existing, fingerprint);

        const context = await transaction.loadContext(
          input.playerId,
          input.encounterId,
          input.ballItemId,
        );
        if (context === null) {
          const terminalReplay = await transaction.findAttempt(idempotency.value.storageKey);
          return terminalReplay === null
            ? err(captureNotFound())
            : replay(terminalReplay, fingerprint);
        }

        const racedReplay = await transaction.findAttempt(idempotency.value.storageKey);
        if (racedReplay !== null) return replay(racedReplay, fingerprint);

        if (!context.playerActive) return err(captureNotReady("Player is not active"));
        if (!context.onboardingComplete) return err(captureNotReady("Onboarding is incomplete"));
        if (context.encounterRevision !== input.expectedEncounterRevision) {
          return err(captureRevisionConflict(input.expectedEncounterRevision));
        }

        const ruleset = RulesetConfigSchema.safeParse(context.rulesetConfig);
        if (!ruleset.success) return err(captureNotReady("Pinned capture ruleset is invalid"));
        const allowed = ruleset.data.capture.allowedEncounterStates ?? ["ENGAGED", "IN_BATTLE"];
        if (!allowed.includes(context.sourceStatus)) {
          return err(captureNotReady("Capture is not allowed from the current encounter state"));
        }

        if (context.sourceStatus === "ENGAGED") {
          if (
            input.expectedBattleVersion !== null ||
            context.battleId !== null ||
            context.battleState !== null
          ) {
            return err(captureNotReady("Engaged encounter must not carry a battle version"));
          }
        } else {
          if (input.expectedBattleVersion === null) {
            return err(
              captureValidationError("expectedBattleVersion is required in battle capture"),
            );
          }
          const wild = battleWild(context);
          if (!wild.ok) return wild;
          if (context.battleState?.version !== input.expectedBattleVersion) {
            return err(captureBattleVersionConflict(input.expectedBattleVersion));
          }
        }

        if (context.ball.itemKind !== "BALL" || context.ball.effectKey !== "catch-modifier") {
          return err(
            captureNotReady("Selected item is not an active capture Ball in the pinned release"),
          );
        }
        const ball = EffectConfigSchemas["catch-modifier"].safeParse(context.ball.effectConfig);
        if (!ball.success) return err(captureNotReady("Capture Ball modifier is invalid"));

        const target = capturedState(context);
        if (!target.ok) return target;
        const probabilityInput = CaptureProbabilityInputSchema.safeParse({
          catchRate: context.catchRate,
          currentHp: target.value.currentHp,
          maxHp: context.encounterSnapshot.maxHp,
          ballMultiplierBasisPoints: ball.data.multiplierBasisPoints,
          status: target.value.majorStatus,
          explicitModifierBasisPoints: modifiers,
          ruleset: ruleset.data.capture,
        });
        if (!probabilityInput.success) {
          return err(captureNotReady("Capture probability inputs are invalid"));
        }
        const probability = captureProbability(probabilityInput.data);

        const attemptId = randomUUID();
        const seed = this.seedProvider.create(`capture:${attemptId}`);
        const rng = new CounterRandomSource(seed.seed);
        const rollBasisPoints = rng.randomInt(10_000);
        const success = rollBasisPoints < probability.probabilityBasisPoints;
        const pokemonInstanceId = success ? createPokemonInstanceId() : null;

        const resolvingRevision = await transaction.beginResolving({
          playerId: input.playerId,
          encounterId: input.encounterId,
          sourceStatus: context.sourceStatus,
          expectedRevision: input.expectedEncounterRevision,
        });
        if (resolvingRevision === null)
          rollback(captureRevisionConflict(input.expectedEncounterRevision));

        const inserted = await transaction.insertPending({
          attemptId,
          playerId: input.playerId,
          encounterId: input.encounterId,
          battleId: context.battleId,
          ballItemId: input.ballItemId,
          idempotencyStorageKey: idempotency.value.storageKey,
          requestFingerprint: fingerprint,
          sourceEncounterStatus: context.sourceStatus,
          correlationId: input.correlationId,
          probabilityBasisPoints: probability.probabilityBasisPoints,
          rollBasisPoints,
          seed: seed.envelope,
          rngCounter: rng.counter,
          breakdown: probability.breakdown,
        });
        if (!inserted)
          rollback(
            captureIntegrityError("Capture idempotency claim was lost after encounter lock"),
          );

        const consumed = await transaction.consumeBall({
          attemptId,
          playerId: input.playerId,
          ballItemId: input.ballItemId,
          idempotencyStorageKey: idempotency.value.storageKey,
          correlationId: input.correlationId,
        });
        if (consumed === "INSUFFICIENT") rollback(captureInsufficientBall(input.ballItemId));
        if (consumed === "CLAIM_CONFLICT") {
          rollback(captureIntegrityError("Capture Ball ledger claim conflicted unexpectedly"));
        }

        if (!success || pokemonInstanceId === null) {
          await transaction.resolveFailure({
            attemptId,
            playerId: input.playerId,
            encounterId: input.encounterId,
            sourceEncounterStatus: context.sourceStatus,
            resolvingEncounterRevision: resolvingRevision,
            correlationId: input.correlationId,
            causationId: input.causationId,
            probabilityBasisPoints: probability.probabilityBasisPoints,
            rollBasisPoints,
          });
          const status = "FAILED" as const;
          return ok({
            captureAttemptId: attemptId,
            encounterId: input.encounterId,
            battleId: context.battleId,
            status,
            probabilityBasisPoints: probability.probabilityBasisPoints,
            rollBasisPoints,
            pokemonInstanceId: null,
            placement: null,
            events: resultEvents({
              id: attemptId,
              encounterId: input.encounterId,
              battleId: context.battleId,
              status,
              probabilityBasisPoints: probability.probabilityBasisPoints,
              rollBasisPoints,
              pokemonInstanceId: null,
            }),
            replayed: false,
          });
        }

        const placement = await transaction.nextRosterPlacement(input.playerId);
        await transaction.resolveSuccess({
          attemptId,
          playerId: input.playerId,
          encounterId: input.encounterId,
          sourceEncounterStatus: context.sourceStatus,
          resolvingEncounterRevision: resolvingRevision,
          correlationId: input.correlationId,
          causationId: input.causationId,
          probabilityBasisPoints: probability.probabilityBasisPoints,
          rollBasisPoints,
          battleId: context.battleId,
          expectedBattleVersion: input.expectedBattleVersion,
          pokemonInstanceId,
          placement,
          captured: target.value,
          encounterSnapshot: context.encounterSnapshot,
          contentReleaseId: context.contentReleaseId,
          rulesetId: context.rulesetId,
        });
        const status = "CAPTURED" as const;
        return ok({
          captureAttemptId: attemptId,
          encounterId: input.encounterId,
          battleId: context.battleId,
          status,
          probabilityBasisPoints: probability.probabilityBasisPoints,
          rollBasisPoints,
          pokemonInstanceId,
          placement,
          events: resultEvents({
            id: attemptId,
            encounterId: input.encounterId,
            battleId: context.battleId,
            status,
            probabilityBasisPoints: probability.probabilityBasisPoints,
            rollBasisPoints,
            pokemonInstanceId,
          }),
          replayed: false,
        });
      });
    } catch (error) {
      return error instanceof CaptureRollback ? err(error.appError) : err(captureIntegrityError());
    }
  }
}
