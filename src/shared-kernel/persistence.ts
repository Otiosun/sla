import type { TransactionId } from "./ids.js";

export type TransactionIsolation = "READ_COMMITTED" | "REPEATABLE_READ" | "SERIALIZABLE";

export interface TransactionPortOptions {
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
}

export interface PersistenceSession {
  readonly transactionId: TransactionId;
}

export interface TransactionBoundaryPort {
  run<T>(
    work: (session: PersistenceSession) => Promise<T>,
    options?: TransactionPortOptions,
  ): Promise<T>;
}

export interface RepositoryPort<Id, Entity> {
  findById(session: PersistenceSession, id: Id): Promise<Entity | null>;
}
