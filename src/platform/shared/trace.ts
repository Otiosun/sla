import type { CausationId, CorrelationId } from "./ids.js";

export interface TraceContext {
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
}

export function rootTrace(correlationId: CorrelationId): TraceContext {
  return { correlationId, causationId: null };
}

export function childTrace(parent: TraceContext, causationId: CausationId): TraceContext {
  return {
    correlationId: parent.correlationId,
    causationId,
  };
}
