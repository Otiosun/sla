import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import type {
  CombatSceneReceipt,
  CombatSceneRecord,
  CombatSceneRepository,
  CombatSceneTransaction,
} from "../../modules/battle/combat-scene-gate.js";

class Transaction implements CombatSceneTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly provider: string,
    private readonly sender: string,
  ) {}
  async receipt(messageId: string): Promise<CombatSceneReceipt | null> {
    const result = await this.client.query<CombatSceneReceipt>(
      "SELECT fingerprint,scope,result FROM combat_scene_receipts WHERE provider=$1 AND sender_ref=$2 AND external_message_id=$3",
      [this.provider, this.sender, messageId],
    );
    return result.rows[0] ?? null;
  }
  async load(scope: string): Promise<CombatSceneRecord | null> {
    const result = await this.client.query<{ record: CombatSceneRecord }>(
      "SELECT record FROM combat_scene_gates WHERE scope=$1 AND provider=$2 AND sender_ref=$3",
      [scope, this.provider, this.sender],
    );
    return result.rows[0]?.record ?? null;
  }
  async save(scope: string, record: CombatSceneRecord): Promise<void> {
    const result = await this.client.query(
      "INSERT INTO combat_scene_gates(scope,provider,sender_ref,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(scope) DO UPDATE SET record=excluded.record,updated_at=now() WHERE combat_scene_gates.provider=excluded.provider AND combat_scene_gates.sender_ref=excluded.sender_ref",
      [scope, this.provider, this.sender, JSON.stringify(record)],
    );
    if (result.rowCount !== 1) throw new Error("Combat scene actor scope conflict");
  }
  async saveReceipt(messageId: string, receipt: CombatSceneReceipt): Promise<void> {
    const result = await this.client.query(
      "INSERT INTO combat_scene_receipts(provider,sender_ref,external_message_id,fingerprint,scope,result) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(provider,sender_ref,external_message_id) DO UPDATE SET result=excluded.result WHERE combat_scene_receipts.fingerprint=excluded.fingerprint AND combat_scene_receipts.scope=excluded.scope",
      [
        this.provider,
        this.sender,
        messageId,
        receipt.fingerprint,
        receipt.scope,
        receipt.result === null ? null : JSON.stringify(receipt.result),
      ],
    );
    if (result.rowCount !== 1) throw new Error("Combat scene receipt conflict");
  }
}
export class PostgresCombatSceneRepository implements CombatSceneRepository {
  constructor(private readonly pool: Pool) {
    if ((pool.options.max ?? 10) < 2)
      throw new Error("Combat scene coordination requires room for a canonical transaction");
  }
  async serialized<T>(
    provider: string,
    sender: string,
    work: (tx: CombatSceneTransaction) => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify(["combat.scene", provider, sender]);
    let client: PoolClient;
    const started = Date.now();
    for (;;) {
      client = await this.pool.connect();
      let acquired = false;
      try {
        const result = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [key],
        );
        acquired = result.rows[0]?.locked === true;
      } catch (error) {
        client.release(true);
        throw error;
      }
      if (acquired) break;
      // Waiters must release their connection: otherwise a burst can exhaust
      // the pool while its lock owner needs another connection for the engine.
      client.release();
      if (Date.now() - started > 30000)
        throw new Error("Combat scene coordinator is busy; retry the same input");
      await delay(10);
    }
    let destroy = false;
    try {
      // Autocommit persists preparation and execution claim before a canonical
      // service uses its own transaction. Its original idempotency key is reused.
      return await work(new Transaction(client, provider, sender));
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      } catch {
        destroy = true;
      }
      client.release(destroy);
    }
  }
}
