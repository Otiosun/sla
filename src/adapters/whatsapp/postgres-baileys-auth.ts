import type { Pool, PoolClient } from "pg";
import {
  createInitialAuthCreds,
  deserializeAuthValue,
  serializeAuthValue,
} from "./baileys-runtime.js";
import type { BaileysAuthBinding } from "./baileys-whatsapp-adapter.js";
import {
  decryptWhatsAppAuthValue,
  encryptWhatsAppAuthValue,
  type EncryptedWhatsAppAuthValue,
} from "./whatsapp-auth-crypto.js";

const SESSION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_BYTES = 32;

interface SessionRow {
  readonly credentials_ciphertext: Buffer;
  readonly credentials_iv: Buffer;
  readonly credentials_auth_tag: Buffer;
  readonly encryption_key_version: number;
  readonly revision: string;
}

interface AuthKeyRow {
  readonly key_id: string;
  readonly value_ciphertext: Buffer;
  readonly value_iv: Buffer;
  readonly value_auth_tag: Buffer;
  readonly encryption_key_version: number;
}

export interface BaileysSignalKeyStoreLike {
  get(type: string, ids: readonly string[]): Promise<Record<string, unknown>>;
  set(
    data: Readonly<Record<string, Readonly<Record<string, unknown | null | undefined>>>>,
  ): Promise<void>;
}

export interface BaileysAuthStateLike {
  readonly creds: Record<string, unknown>;
  readonly keys: BaileysSignalKeyStoreLike;
}

export interface PostgresBaileysAuthOptions {
  readonly sessionKey: string;
  readonly encryptionKey: Uint8Array;
  readonly encryptionKeyVersion: number;
  readonly allowCreate?: boolean;
}

export class WhatsAppAuthNotBootstrappedError extends Error {
  override readonly name = "WhatsAppAuthNotBootstrappedError";
}

export class WhatsAppAuthLeaseUnavailableError extends Error {
  override readonly name = "WhatsAppAuthLeaseUnavailableError";
}

export class WhatsAppAuthKeyVersionError extends Error {
  override readonly name = "WhatsAppAuthKeyVersionError";
}

export class WhatsAppAuthRevisionConflictError extends Error {
  override readonly name = "WhatsAppAuthRevisionConflictError";
}

function assertOptions(options: PostgresBaileysAuthOptions): void {
  if (!SESSION_KEY_PATTERN.test(options.sessionKey)) {
    throw new Error("WhatsApp auth session key is invalid");
  }
  if (options.encryptionKey.byteLength !== KEY_BYTES) {
    throw new Error(`WhatsApp auth encryption key must be exactly ${KEY_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(options.encryptionKeyVersion) || options.encryptionKeyVersion <= 0) {
    throw new Error("WhatsApp auth encryption key version must be a positive safe integer");
  }
}

function credentialsContext(sessionKey: string): string {
  return `whatsapp-auth:${sessionKey}:credentials`;
}

function signalKeyContext(sessionKey: string, type: string, id: string): string {
  return `whatsapp-auth:${sessionKey}:key:${type}:${id}`;
}

function encryptedFromSession(row: SessionRow): EncryptedWhatsAppAuthValue {
  return {
    ciphertext: row.credentials_ciphertext,
    iv: row.credentials_iv,
    authTag: row.credentials_auth_tag,
  };
}

function encryptedFromKey(row: AuthKeyRow): EncryptedWhatsAppAuthValue {
  return {
    ciphertext: row.value_ciphertext,
    iv: row.value_iv,
    authTag: row.value_auth_tag,
  };
}

function credentialsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored WhatsApp credentials are invalid");
  }
  return value as Record<string, unknown>;
}

export class PostgresBaileysAuthBinding implements BaileysAuthBinding {
  public readonly state: BaileysAuthStateLike;

  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly client: PoolClient,
    private readonly sessionKey: string,
    private readonly encryptionKey: Buffer,
    private readonly encryptionKeyVersion: number,
    private readonly credentials: Record<string, unknown>,
    private sessionRevision: bigint,
  ) {
    this.state = {
      creds: credentials,
      keys: {
        get: (type, ids) => this.getKeys(type, ids),
        set: (data) => this.setKeys(data),
      },
    };
  }

  public static async open(
    pool: Pool,
    options: PostgresBaileysAuthOptions,
  ): Promise<PostgresBaileysAuthBinding> {
    assertOptions(options);
    const client = await pool.connect();
    let leaseAcquired = false;
    try {
      const lease = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [`whatsapp-auth-session:${options.sessionKey}`],
      );
      leaseAcquired = lease.rows[0]?.acquired === true;
      if (!leaseAcquired) {
        throw new WhatsAppAuthLeaseUnavailableError(
          "WhatsApp auth session is already owned by another runtime",
        );
      }

      let session = await PostgresBaileysAuthBinding.loadSession(client, options.sessionKey);
      if (session === null) {
        if (options.allowCreate !== true) {
          throw new WhatsAppAuthNotBootstrappedError(
            "WhatsApp auth session has not been bootstrapped",
          );
        }
        const credentials = credentialsObject(createInitialAuthCreds());
        const encrypted = encryptWhatsAppAuthValue(
          serializeAuthValue(credentials),
          options.encryptionKey,
          credentialsContext(options.sessionKey),
        );
        const inserted = await client.query<SessionRow>(
          `INSERT INTO whatsapp_auth_sessions(
             session_key, credentials_ciphertext, credentials_iv, credentials_auth_tag,
             encryption_key_version, revision
           ) VALUES ($1, $2, $3, $4, $5, 0)
           ON CONFLICT (session_key) DO NOTHING
           RETURNING credentials_ciphertext, credentials_iv, credentials_auth_tag,
                     encryption_key_version, revision::text`,
          [
            options.sessionKey,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
            options.encryptionKeyVersion,
          ],
        );
        session =
          inserted.rows[0] ??
          (await PostgresBaileysAuthBinding.loadSession(client, options.sessionKey));
        if (session === null) throw new Error("WhatsApp auth bootstrap did not persist a session");
      }

      if (session.encryption_key_version !== options.encryptionKeyVersion) {
        throw new WhatsAppAuthKeyVersionError("WhatsApp auth encryption key version mismatch");
      }
      const serialized = decryptWhatsAppAuthValue(
        encryptedFromSession(session),
        options.encryptionKey,
        credentialsContext(options.sessionKey),
      );
      const credentials = credentialsObject(deserializeAuthValue(serialized));
      return new PostgresBaileysAuthBinding(
        client,
        options.sessionKey,
        Buffer.from(options.encryptionKey),
        options.encryptionKeyVersion,
        credentials,
        BigInt(session.revision),
      );
    } catch (error) {
      if (leaseAcquired) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            `whatsapp-auth-session:${options.sessionKey}`,
          ]);
        } catch {
          // The original failure remains authoritative.
        }
      }
      client.release();
      throw error;
    }
  }

  public async saveCredentials(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      const encrypted = encryptWhatsAppAuthValue(
        serializeAuthValue(this.credentials),
        this.encryptionKey,
        credentialsContext(this.sessionKey),
      );
      const updated = await this.client.query<{ revision: string }>(
        `UPDATE whatsapp_auth_sessions
         SET credentials_ciphertext = $2,
             credentials_iv = $3,
             credentials_auth_tag = $4,
             encryption_key_version = $5,
             revision = revision + 1,
             updated_at = now()
         WHERE session_key = $1 AND revision = $6::bigint
         RETURNING revision::text`,
        [
          this.sessionKey,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          this.encryptionKeyVersion,
          this.sessionRevision.toString(),
        ],
      );
      const revision = updated.rows[0]?.revision;
      if (revision === undefined) {
        throw new WhatsAppAuthRevisionConflictError("WhatsApp credential revision conflict");
      }
      this.sessionRevision = BigInt(revision);
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.queue;
    this.closed = true;
    try {
      await this.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `whatsapp-auth-session:${this.sessionKey}`,
      ]);
    } finally {
      this.client.release();
    }
  }

  private static async loadSession(
    client: PoolClient,
    sessionKey: string,
  ): Promise<SessionRow | null> {
    const result = await client.query<SessionRow>(
      `SELECT credentials_ciphertext, credentials_iv, credentials_auth_tag,
              encryption_key_version, revision::text
       FROM whatsapp_auth_sessions
       WHERE session_key = $1`,
      [sessionKey],
    );
    return result.rows[0] ?? null;
  }

  private async getKeys(type: string, ids: readonly string[]): Promise<Record<string, unknown>> {
    if (ids.length === 0) return {};
    return this.enqueueValue(async () => {
      this.assertOpen();
      const result = await this.client.query<AuthKeyRow>(
        `SELECT key_id, value_ciphertext, value_iv, value_auth_tag, encryption_key_version
         FROM whatsapp_auth_keys
         WHERE session_key = $1 AND key_type = $2 AND key_id = ANY($3::text[])
           AND deleted = FALSE`,
        [this.sessionKey, type, [...ids]],
      );
      const output: Record<string, unknown> = {};
      for (const row of result.rows) {
        if (row.encryption_key_version !== this.encryptionKeyVersion) {
          throw new WhatsAppAuthKeyVersionError("WhatsApp signal key version mismatch");
        }
        const serialized = decryptWhatsAppAuthValue(
          encryptedFromKey(row),
          this.encryptionKey,
          signalKeyContext(this.sessionKey, type, row.key_id),
        );
        output[row.key_id] = deserializeAuthValue(serialized, type);
      }
      return output;
    });
  }

  private async setKeys(
    data: Readonly<Record<string, Readonly<Record<string, unknown | null | undefined>>>>,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.client.query("BEGIN");
      try {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            if (value === null || value === undefined) {
              await this.client.query(
                `INSERT INTO whatsapp_auth_keys(
                   session_key, key_type, key_id, value_ciphertext, value_iv, value_auth_tag,
                   encryption_key_version, deleted, revision
                 ) VALUES ($1, $2, $3, NULL, NULL, NULL, $4, TRUE, 0)
                 ON CONFLICT (session_key, key_type, key_id) DO UPDATE
                 SET value_ciphertext = NULL,
                     value_iv = NULL,
                     value_auth_tag = NULL,
                     encryption_key_version = EXCLUDED.encryption_key_version,
                     deleted = TRUE,
                     revision = whatsapp_auth_keys.revision + 1,
                     updated_at = now()`,
                [this.sessionKey, type, id, this.encryptionKeyVersion],
              );
              continue;
            }
            const encrypted = encryptWhatsAppAuthValue(
              serializeAuthValue(value),
              this.encryptionKey,
              signalKeyContext(this.sessionKey, type, id),
            );
            await this.client.query(
              `INSERT INTO whatsapp_auth_keys(
                 session_key, key_type, key_id, value_ciphertext, value_iv, value_auth_tag,
                 encryption_key_version, deleted, revision
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 0)
               ON CONFLICT (session_key, key_type, key_id) DO UPDATE
               SET value_ciphertext = EXCLUDED.value_ciphertext,
                   value_iv = EXCLUDED.value_iv,
                   value_auth_tag = EXCLUDED.value_auth_tag,
                   encryption_key_version = EXCLUDED.encryption_key_version,
                   deleted = FALSE,
                   revision = whatsapp_auth_keys.revision + 1,
                   updated_at = now()`,
              [
                this.sessionKey,
                type,
                id,
                encrypted.ciphertext,
                encrypted.iv,
                encrypted.authTag,
                this.encryptionKeyVersion,
              ],
            );
          }
        }
        await this.client.query("COMMIT");
      } catch (error) {
        try {
          await this.client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
        throw error;
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("WhatsApp auth binding is closed");
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private enqueueValue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
