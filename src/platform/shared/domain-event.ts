import type { CausationId, CorrelationId, DomainEventId, DomainId } from "./ids.js";

export interface DomainEventEnvelope<
  EventType extends string = string,
  Payload = unknown,
  AggregateId extends DomainId<string> = DomainId<string>,
> {
  readonly eventId: DomainEventId;
  readonly eventType: EventType;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: AggregateId;
  readonly payload: Payload;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
}

export function domainEvent<
  EventType extends string,
  Payload,
  AggregateId extends DomainId<string>,
>(
  input: DomainEventEnvelope<EventType, Payload, AggregateId>,
): DomainEventEnvelope<EventType, Payload, AggregateId> {
  if (input.eventType.trim().length === 0) {
    throw new TypeError("domain event type must not be empty");
  }
  if (!Number.isSafeInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new RangeError("domain event version must be a positive safe integer");
  }
  if (input.aggregateType.trim().length === 0) {
    throw new TypeError("domain event aggregate type must not be empty");
  }
  if (!Number.isFinite(input.occurredAt.getTime())) {
    throw new RangeError("domain event occurredAt must be valid");
  }

  return Object.freeze({
    ...input,
    occurredAt: new Date(input.occurredAt.getTime()),
  });
}
