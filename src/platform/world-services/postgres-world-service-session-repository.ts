import type { Pool } from "pg";
import type { WorldServiceSessionRepository } from "../../modules/world-services/ports.js";

export class PostgresWorldServiceSessionRepository implements WorldServiceSessionRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(): Promise<T> {
    void this.pool;
    throw new Error("World service session persistence is not implemented yet");
  }

  public async read<T>(): Promise<T> {
    void this.pool;
    throw new Error("World service session persistence is not implemented yet");
  }
}
