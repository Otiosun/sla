import type { CausationId, CorrelationId } from "./ids.js";

export interface CausalityContext {
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
}

export function rootCausality(correlationId: CorrelationId): CausalityContext {
  return { correlationId, causationId: null };
}

export function causedBy(parent: CausalityContext, causationId: CausationId): CausalityContext {
  return {
    correlationId: parent.correlationId,
    causationId,
  };
}
