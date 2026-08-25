export interface TransactionRunner<Transaction> {
  runInTransaction<Result>(work: (transaction: Transaction) => Promise<Result>): Promise<Result>;
}

export interface ReadRepository<Entity, Id, Transaction> {
  getById(transaction: Transaction, id: Id): Promise<Entity | null>;
}

export interface WriteRepository<Entity, Transaction> {
  insert(transaction: Transaction, entity: Entity): Promise<void>;
  update(transaction: Transaction, entity: Entity): Promise<void>;
}

export type Repository<Entity, Id, Transaction> = ReadRepository<Entity, Id, Transaction> &
  WriteRepository<Entity, Transaction>;
