import type { Clock } from "../platform/clock/index.js";
import type { CausalityContext } from "./causality.js";
import { createDomainEventId, type DomainId, type DomainEventId } from "./ids.js";

export interface AggregateRef {
  readonly type: string;
  readonly id: DomainId;
}

export interface DomainEventEnvelope<Type extends string, Payload> {
  readonly envelopeVersion: 1;
  readonly eventId: DomainEventId;
  readonly eventType: Type;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly aggregate: AggregateRef;
  readonly correlationId: CausalityContext["correlationId"];
  readonly causationId: CausalityContext["causationId"];
  readonly payload: Payload;
}

export function domainEvent<Type extends string, Payload>(input: {
  readonly eventType: Type;
  readonly eventVersion: number;
  readonly aggregate: AggregateRef;
  readonly causality: CausalityContext;
  readonly payload: Payload;
  readonly clock: Clock;
}): DomainEventEnvelope<Type, Payload> {
  if (!Number.isSafeInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new RangeError("Domain event version must be a positive safe integer");
  }

  return {
    envelopeVersion: 1,
    eventId: createDomainEventId(),
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    occurredAt: input.clock.now().toISOString(),
    aggregate: input.aggregate,
    correlationId: input.causality.correlationId,
    causationId: input.causality.causationId,
    payload: input.payload,
  };
}
