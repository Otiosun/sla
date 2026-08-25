import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appError, err, ok, type Result } from "./result.js";

const uuidSchema = z.string().uuid();

declare const brandSymbol: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brandSymbol]: Name };

export type PlayerId = Brand<string, "PlayerId">;
export type PokemonInstanceId = Brand<string, "PokemonInstanceId">;
export type BattleId = Brand<string, "BattleId">;
export type EncounterId = Brand<string, "EncounterId">;
export type DomainEventId = Brand<string, "DomainEventId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type CausationId = Brand<string, "CausationId">;
export type TransactionId = Brand<string, "TransactionId">;

export type DomainId =
  | PlayerId
  | PokemonInstanceId
  | BattleId
  | EncounterId
  | DomainEventId
  | CorrelationId
  | CausationId
  | TransactionId;

function parseUuid<Name extends string>(value: string, kind: Name): Result<Brand<string, Name>> {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      appError("INVALID_ID", `Invalid ${kind}`, {
        kind,
      }),
    );
  }
  return ok(parsed.data as Brand<string, Name>);
}

function createUuid<Name extends string>(): Brand<string, Name> {
  return randomUUID() as Brand<string, Name>;
}

export const parsePlayerId = (value: string): Result<PlayerId> => parseUuid(value, "PlayerId");
export const parsePokemonInstanceId = (value: string): Result<PokemonInstanceId> =>
  parseUuid(value, "PokemonInstanceId");
export const parseBattleId = (value: string): Result<BattleId> => parseUuid(value, "BattleId");
export const parseEncounterId = (value: string): Result<EncounterId> =>
  parseUuid(value, "EncounterId");
export const parseDomainEventId = (value: string): Result<DomainEventId> =>
  parseUuid(value, "DomainEventId");
export const parseCorrelationId = (value: string): Result<CorrelationId> =>
  parseUuid(value, "CorrelationId");
export const parseCausationId = (value: string): Result<CausationId> =>
  parseUuid(value, "CausationId");
export const parseTransactionId = (value: string): Result<TransactionId> =>
  parseUuid(value, "TransactionId");

export const createPlayerId = (): PlayerId => createUuid();
export const createPokemonInstanceId = (): PokemonInstanceId => createUuid();
export const createBattleId = (): BattleId => createUuid();
export const createEncounterId = (): EncounterId => createUuid();
export const createDomainEventId = (): DomainEventId => createUuid();
export const createCorrelationId = (): CorrelationId => createUuid();
export const createCausationId = (): CausationId => createUuid();
export const createTransactionId = (): TransactionId => createUuid();
