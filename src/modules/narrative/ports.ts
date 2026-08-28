import type { NarrativeProviderContext, ResolvedNarrativeEvent } from "./contracts.js";

export interface NarrativeInterpreterCapabilities {
  readonly structuredJson: boolean;
}

export interface NarrativeInterpreterRequest {
  readonly contractVersion: "narrative-intent.v1";
  readonly systemPolicyId: "N0_SAFE_V1";
  readonly responseMode: "JSON_CONSTRAINED" | "JSON_BEST_EFFORT";
  readonly context: NarrativeProviderContext;
}

export type NarrativeInterpreterResult =
  | { readonly ok: true; readonly output: unknown }
  | {
      readonly ok: false;
      readonly reason: "QUOTA" | "OFFLINE" | "PROVIDER_ERROR";
    };

export interface NarrativeInterpreter {
  readonly name: string;
  readonly capabilities: NarrativeInterpreterCapabilities;
  interpret(
    request: NarrativeInterpreterRequest,
    signal: AbortSignal,
  ): Promise<NarrativeInterpreterResult>;
}

export interface NarrativeRenderer {
  render(events: readonly ResolvedNarrativeEvent[]): string;
}

export interface NarrativeTelemetryEvent {
  readonly operation: "interpret";
  readonly outcome: string;
  readonly provider: string;
  readonly durationMs: number;
}

export interface NarrativeTelemetry {
  record(event: NarrativeTelemetryEvent): void;
}

export const NOOP_NARRATIVE_TELEMETRY: NarrativeTelemetry = {
  record() {},
};
