import type { Clock } from "../../platform/clock/index.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  NarrativeIntentV1Schema,
  ResolvedNarrativeEventSchema,
  type NarrativeContextInput,
  type NarrativeFallbackReason,
  type NarrativeInterpretation,
  type NarrativeIntentV1,
  type NarrativeLegalAction,
  type ResolvedNarrativeEvent,
} from "./contracts.js";
import { NarrativeContextBuilder } from "./context-builder.js";
import {
  NOOP_NARRATIVE_TELEMETRY,
  type NarrativeInterpreter,
  type NarrativeInterpreterRequest,
  type NarrativeInterpreterResult,
  type NarrativeRenderer,
  type NarrativeTelemetry,
} from "./ports.js";

export interface NarrativeN0Policy {
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxInputChars: number;
  readonly maxOutputChars: number;
  readonly minimumConfidence: number;
  readonly circuitFailureThreshold: number;
  readonly circuitCooldownMs: number;
}

export const DEFAULT_NARRATIVE_N0_POLICY: NarrativeN0Policy = {
  enabled: false,
  timeoutMs: 1_500,
  maxInputChars: 4_000,
  maxOutputChars: 2_000,
  minimumConfidence: 0.65,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
};

function fallback(reason: NarrativeFallbackReason): NarrativeInterpretation {
  return {
    status: "FALLBACK",
    intent: null,
    fallbackReason: reason,
    mechanicalAuthority: "NONE",
  };
}

function serializedLength(value: unknown): number | null {
  try {
    return JSON.stringify(value).length;
  } catch {
    return null;
  }
}

function decodeOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

function intentMatchesAction(
  intent: NarrativeIntentV1,
  action: NarrativeLegalAction,
): boolean {
  if (intent.actorId !== action.actorId) return false;
  if (intent.moveId !== action.moveId) return false;
  if (intent.itemId !== action.itemId) return false;
  if (action.targetIds.length === 0) return intent.targetId === null;
  return intent.targetId !== null && action.targetIds.includes(intent.targetId);
}

function legalIntent(
  intent: NarrativeIntentV1,
  actions: readonly NarrativeLegalAction[],
): boolean {
  if (intent.actionId === null) {
    return (
      intent.actorId === null &&
      intent.targetId === null &&
      intent.moveId === null &&
      intent.itemId === null
    );
  }
  const action = actions.find((candidate) => candidate.actionId === intent.actionId);
  return action !== undefined && intentMatchesAction(intent, action);
}

export class CanonicalNarrativeRenderer implements NarrativeRenderer {
  public render(events: readonly ResolvedNarrativeEvent[]): string {
    const parsed = events.map((event) => ResolvedNarrativeEventSchema.parse(event));
    return parsed.map((event) => event.canonicalText).join("\n");
  }
}

export class NarrativeN0Service {
  private consecutiveFailures = 0;
  private circuitOpenUntilMs = 0;

  public constructor(
    private readonly interpreter: NarrativeInterpreter,
    private readonly clock: Clock,
    private readonly policy: NarrativeN0Policy = DEFAULT_NARRATIVE_N0_POLICY,
    private readonly contextBuilder = new NarrativeContextBuilder(),
    private readonly telemetry: NarrativeTelemetry = NOOP_NARRATIVE_TELEMETRY,
  ) {}

  public async interpret(input: NarrativeContextInput): Promise<Result<NarrativeInterpretation>> {
    const built = this.contextBuilder.build(input);
    if (!built.ok) return built;
    if (!this.policy.enabled) return ok(fallback("DISABLED"));
    if (built.value.userText.length > this.policy.maxInputChars) {
      return ok(fallback("INPUT_BUDGET"));
    }

    const nowMs = this.clock.now().getTime();
    if (nowMs < this.circuitOpenUntilMs) return ok(fallback("CIRCUIT_OPEN"));

    const request: NarrativeInterpreterRequest = {
      contractVersion: "narrative-intent.v1",
      systemPolicyId: "N0_SAFE_V1",
      responseMode: this.interpreter.capabilities.structuredJson
        ? "JSON_CONSTRAINED"
        : "JSON_BEST_EFFORT",
      context: built.value,
    };
    const started = Date.now();
    const provider = await this.withTimeout(request);
    const durationMs = Math.max(0, Date.now() - started);

    if (provider.kind === "TIMEOUT") {
      this.registerFailure(nowMs);
      this.record("TIMEOUT", durationMs);
      return ok(fallback("TIMEOUT"));
    }
    if (!provider.result.ok) {
      this.registerFailure(nowMs);
      this.record(provider.result.reason, durationMs);
      return ok(fallback(provider.result.reason));
    }

    const length = serializedLength(provider.result.output);
    if (length === null) {
      this.registerFailure(nowMs);
      this.record("INVALID_OUTPUT", durationMs);
      return ok(fallback("INVALID_OUTPUT"));
    }
    if (length > this.policy.maxOutputChars) {
      this.registerFailure(nowMs);
      this.record("OUTPUT_BUDGET", durationMs);
      return ok(fallback("OUTPUT_BUDGET"));
    }

    const parsed = NarrativeIntentV1Schema.safeParse(decodeOutput(provider.result.output));
    if (!parsed.success) {
      this.registerFailure(nowMs);
      this.record("INVALID_OUTPUT", durationMs);
      return ok(fallback("INVALID_OUTPUT"));
    }
    if (!legalIntent(parsed.data, built.value.legalActions)) {
      this.registerFailure(nowMs);
      this.record("ILLEGAL_REFERENCE", durationMs);
      return ok(fallback("ILLEGAL_REFERENCE"));
    }
    if (parsed.data.confidence < this.policy.minimumConfidence) {
      this.registerFailure(nowMs);
      this.record("LOW_CONFIDENCE", durationMs);
      return ok(fallback("LOW_CONFIDENCE"));
    }

    this.consecutiveFailures = 0;
    this.circuitOpenUntilMs = 0;
    this.record("ENRICHED", durationMs);
    return ok({
      status: "ENRICHED",
      intent: parsed.data,
      fallbackReason: null,
      mechanicalAuthority: "NONE",
    });
  }

  public renderResolved(events: readonly ResolvedNarrativeEvent[], renderer: NarrativeRenderer): Result<string> {
    try {
      return ok(renderer.render(events));
    } catch {
      return err(appError("VALIDATION_FAILED", "Resolved narrative events are invalid"));
    }
  }

  private async withTimeout(
    request: NarrativeInterpreterRequest,
  ): Promise<
    | { readonly kind: "RESULT"; readonly result: NarrativeInterpreterResult }
    | { readonly kind: "TIMEOUT" }
  > {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.interpreter
          .interpret(request, controller.signal)
          .then((result) => ({ kind: "RESULT", result }) as const)
          .catch(() => ({
            kind: "RESULT",
            result: { ok: false, reason: "PROVIDER_ERROR" } as const,
          })),
        new Promise<{ readonly kind: "TIMEOUT" }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ kind: "TIMEOUT" });
          }, this.policy.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private registerFailure(nowMs: number): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      this.circuitOpenUntilMs = nowMs + this.policy.circuitCooldownMs;
    }
  }

  private record(outcome: string, durationMs: number): void {
    this.telemetry.record({
      operation: "interpret",
      outcome,
      provider: this.interpreter.name,
      durationMs,
    });
  }
}
