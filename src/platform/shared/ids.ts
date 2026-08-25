import { randomUUID } from "node:crypto";
import { z } from "zod";

declare const domainIdBrand: unique symbol;

export type DomainId<Kind extends string> = string & {
  readonly [domainIdBrand]: Kind;
};

const uuidSchema = z.string().uuid();

function parseDomainId<Kind extends string>(kind: Kind, value: unknown): DomainId<Kind> {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${kind} must be a valid UUID`);
  }
  return parsed.data as DomainId<Kind>;
}

function newDomainId<Kind extends string>(kind: Kind): DomainId<Kind> {
  return parseDomainId(kind, randomUUID());
}

export type PlayerId = DomainId<"PlayerId">;
export type PokemonInstanceId = DomainId<"PokemonInstanceId">;
export type BattleId = DomainId<"BattleId">;
export type EncounterId = DomainId<"EncounterId">;
export type CaptureAttemptId = DomainId<"CaptureAttemptId">;
export type ContentReleaseId = DomainId<"ContentReleaseId">;
export type RulesetId = DomainId<"RulesetId">;
export type ItemId = DomainId<"ItemId">;
export type MoveId = DomainId<"MoveId">;
export type AbilityId = DomainId<"AbilityId">;
export type AreaId = DomainId<"AreaId">;
export type AdminOperationId = DomainId<"AdminOperationId">;
export type DomainEventId = DomainId<"DomainEventId">;
export type CorrelationId = DomainId<"CorrelationId">;
export type CausationId = DomainId<"CausationId">;

export const asPlayerId = (value: unknown): PlayerId => parseDomainId("PlayerId", value);
export const asPokemonInstanceId = (value: unknown): PokemonInstanceId =>
  parseDomainId("PokemonInstanceId", value);
export const asBattleId = (value: unknown): BattleId => parseDomainId("BattleId", value);
export const asEncounterId = (value: unknown): EncounterId => parseDomainId("EncounterId", value);
export const asCaptureAttemptId = (value: unknown): CaptureAttemptId =>
  parseDomainId("CaptureAttemptId", value);
export const asContentReleaseId = (value: unknown): ContentReleaseId =>
  parseDomainId("ContentReleaseId", value);
export const asRulesetId = (value: unknown): RulesetId => parseDomainId("RulesetId", value);
export const asItemId = (value: unknown): ItemId => parseDomainId("ItemId", value);
export const asMoveId = (value: unknown): MoveId => parseDomainId("MoveId", value);
export const asAbilityId = (value: unknown): AbilityId => parseDomainId("AbilityId", value);
export const asAreaId = (value: unknown): AreaId => parseDomainId("AreaId", value);
export const asAdminOperationId = (value: unknown): AdminOperationId =>
  parseDomainId("AdminOperationId", value);
export const asDomainEventId = (value: unknown): DomainEventId =>
  parseDomainId("DomainEventId", value);
export const asCorrelationId = (value: unknown): CorrelationId =>
  parseDomainId("CorrelationId", value);
export const asCausationId = (value: unknown): CausationId => parseDomainId("CausationId", value);

export const newDomainEventId = (): DomainEventId => newDomainId("DomainEventId");
export const newCorrelationId = (): CorrelationId => newDomainId("CorrelationId");
export const newCausationId = (): CausationId => newDomainId("CausationId");
