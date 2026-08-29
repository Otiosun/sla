import { Pool } from "pg";
import {
  PostgresBaileysAuthBinding,
  WhatsAppAuthKeyVersionError,
  WhatsAppAuthLeaseUnavailableError,
  WhatsAppAuthNotBootstrappedError,
} from "../../src/adapters/whatsapp/postgres-baileys-auth.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 17 WhatsApp auth proof");
}

const KEY = Buffer.alloc(32, 0x51);
const SESSION = "phase17-proof";

async function expectReject<T>(
  promise: Promise<T>,
  errorType: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof errorType) return;
    throw error;
  }
  throw new Error(`Expected ${errorType.name}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await pool.query("DELETE FROM whatsapp_auth_keys WHERE session_key = $1", [SESSION]);
    await pool.query("DELETE FROM whatsapp_auth_sessions WHERE session_key = $1", [SESSION]);

    await expectReject(
      PostgresBaileysAuthBinding.open(pool, {
        sessionKey: SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      }),
      WhatsAppAuthNotBootstrappedError,
    );

    const auth = await PostgresBaileysAuthBinding.open(pool, {
      sessionKey: SESSION,
      encryptionKey: KEY,
      encryptionKeyVersion: 1,
      allowCreate: true,
    });
    auth.state.creds.proofMarker = Buffer.from("durable-credentials");
    await auth.saveCredentials();
    await auth.state.keys.set({
      "pre-key": {
        alpha: Buffer.from([1, 2, 3, 4]),
        beta: { value: "encrypted-signal-key" },
      },
    });

    const firstRead = await auth.state.keys.get("pre-key", ["alpha", "beta"]);
    if (!Buffer.isBuffer(firstRead.alpha)) throw new Error("Signal BufferJSON round-trip failed");
    if (JSON.stringify(firstRead.beta) !== JSON.stringify({ value: "encrypted-signal-key" })) {
      throw new Error("Signal object round-trip failed");
    }

    await expectReject(
      PostgresBaileysAuthBinding.open(pool, {
        sessionKey: SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      }),
      WhatsAppAuthLeaseUnavailableError,
    );

    await auth.close();

    const reopened = await PostgresBaileysAuthBinding.open(pool, {
      sessionKey: SESSION,
      encryptionKey: KEY,
      encryptionKeyVersion: 1,
    });
    if (!Buffer.isBuffer(reopened.state.creds.proofMarker)) {
      throw new Error("Credential BufferJSON round-trip failed");
    }
    const marker = reopened.state.creds.proofMarker;
    if (!Buffer.isBuffer(marker) || marker.toString("utf8") !== "durable-credentials") {
      throw new Error("Durable credentials were not recovered exactly");
    }

    await reopened.state.keys.set({ "pre-key": { alpha: null } });
    const afterDelete = await reopened.state.keys.get("pre-key", ["alpha", "beta"]);
    if (afterDelete.alpha !== undefined || afterDelete.beta === undefined) {
      throw new Error("Signal-key tombstone semantics failed");
    }
    await reopened.close();

    await expectReject(
      PostgresBaileysAuthBinding.open(pool, {
        sessionKey: SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 2,
      }),
      WhatsAppAuthKeyVersionError,
    );

    const storage = await pool.query<{
      credentials_hex: string;
      signal_hex: string | null;
      deleted: boolean | null;
    }>(
      `SELECT encode(session.credentials_ciphertext, 'hex') AS credentials_hex,
              encode(key.value_ciphertext, 'hex') AS signal_hex,
              key.deleted
       FROM whatsapp_auth_sessions session
       LEFT JOIN whatsapp_auth_keys key
         ON key.session_key = session.session_key
        AND key.key_type = 'pre-key' AND key.key_id = 'alpha'
       WHERE session.session_key = $1`,
      [SESSION],
    );
    const row = storage.rows[0];
    if (row === undefined) throw new Error("WhatsApp auth session disappeared");
    if (row.credentials_hex.includes(Buffer.from("durable-credentials").toString("hex"))) {
      throw new Error("Credential plaintext leaked into PostgreSQL ciphertext");
    }
    if (row.deleted !== true || row.signal_hex !== null) {
      throw new Error("Deleted Signal key did not remain a ciphertext-free tombstone");
    }

    process.stdout.write("phase17 whatsapp auth proof passed\n");
  } finally {
    await pool.end();
  }
}

await main();
