import { Pool } from "pg";
import {
  PostgresBaileysAuthBinding,
  WhatsAppAuthAlreadyBootstrappedError,
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
const SNAPSHOT_SESSION = "phase17-snapshot-proof";
const ROLLBACK_SESSION = "phase17-snapshot-rollback";
const RESERVATION_SESSION = "phase17-reservation-proof";

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

async function expectAnyReject<T>(promise: Promise<T>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error("Expected promise rejection");
}

async function deleteProofSession(pool: Pool, sessionKey: string): Promise<void> {
  await pool.query("DELETE FROM whatsapp_auth_keys WHERE session_key = $1", [sessionKey]);
  await pool.query("DELETE FROM whatsapp_auth_sessions WHERE session_key = $1", [sessionKey]);
}

async function sessionCount(pool: Pool, sessionKey: string): Promise<string | undefined> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM whatsapp_auth_sessions WHERE session_key = $1",
    [sessionKey],
  );
  return result.rows[0]?.count;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  try {
    await deleteProofSession(pool, SESSION);
    await deleteProofSession(pool, SNAPSHOT_SESSION);
    await deleteProofSession(pool, ROLLBACK_SESSION);
    await deleteProofSession(pool, RESERVATION_SESSION);

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
      requireCreate: true,
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
        allowCreate: true,
        requireCreate: true,
      }),
      WhatsAppAuthLeaseUnavailableError,
    );

    await auth.close();

    await expectReject(
      PostgresBaileysAuthBinding.open(pool, {
        sessionKey: SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
        allowCreate: true,
        requireCreate: true,
      }),
      WhatsAppAuthAlreadyBootstrappedError,
    );

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

    await PostgresBaileysAuthBinding.bootstrapFromSnapshot(
      pool,
      {
        sessionKey: SNAPSHOT_SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      },
      {
        creds: { snapshotMarker: Buffer.from("connected-before-persist") },
        keys: {
          "pre-key": {
            gamma: Buffer.from([9, 8, 7, 6]),
            delta: { value: "snapshot-signal-key" },
          },
        },
      },
    );

    await expectReject(
      PostgresBaileysAuthBinding.bootstrapFromSnapshot(
        pool,
        {
          sessionKey: SNAPSHOT_SESSION,
          encryptionKey: KEY,
          encryptionKeyVersion: 1,
        },
        { creds: {}, keys: {} },
      ),
      WhatsAppAuthAlreadyBootstrappedError,
    );

    const snapshotAuth = await PostgresBaileysAuthBinding.open(pool, {
      sessionKey: SNAPSHOT_SESSION,
      encryptionKey: KEY,
      encryptionKeyVersion: 1,
    });
    const snapshotMarker = snapshotAuth.state.creds.snapshotMarker;
    if (
      !Buffer.isBuffer(snapshotMarker) ||
      snapshotMarker.toString("utf8") !== "connected-before-persist"
    ) {
      throw new Error("Atomic snapshot credentials were not recovered exactly");
    }
    const snapshotKeys = await snapshotAuth.state.keys.get("pre-key", ["gamma", "delta"]);
    if (!Buffer.isBuffer(snapshotKeys.gamma)) {
      throw new Error("Atomic snapshot Signal BufferJSON round-trip failed");
    }
    if (JSON.stringify(snapshotKeys.delta) !== JSON.stringify({ value: "snapshot-signal-key" })) {
      throw new Error("Atomic snapshot Signal object round-trip failed");
    }
    await snapshotAuth.close();

    await expectAnyReject(
      PostgresBaileysAuthBinding.bootstrapFromSnapshot(
        pool,
        {
          sessionKey: ROLLBACK_SESSION,
          encryptionKey: KEY,
          encryptionKeyVersion: 1,
        },
        {
          creds: { shouldRollback: true },
          keys: {
            "pre-key": {
              ["x".repeat(513)]: Buffer.from([1]),
            },
          },
        },
      ),
    );
    if ((await sessionCount(pool, ROLLBACK_SESSION)) !== "0") {
      throw new Error("Failed snapshot bootstrap left a partial WhatsApp auth session");
    }

    const abandonedReservation = await PostgresBaileysAuthBinding.reserveBootstrap(pool, {
      sessionKey: RESERVATION_SESSION,
      encryptionKey: KEY,
      encryptionKeyVersion: 1,
    });
    if ((await sessionCount(pool, RESERVATION_SESSION)) !== "0") {
      throw new Error("Bootstrap reservation persisted auth before provider connection");
    }
    await expectReject(
      PostgresBaileysAuthBinding.open(pool, {
        sessionKey: RESERVATION_SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      }),
      WhatsAppAuthLeaseUnavailableError,
    );
    await expectReject(
      PostgresBaileysAuthBinding.reserveBootstrap(pool, {
        sessionKey: RESERVATION_SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      }),
      WhatsAppAuthLeaseUnavailableError,
    );
    await abandonedReservation.close();
    if ((await sessionCount(pool, RESERVATION_SESSION)) !== "0") {
      throw new Error("Abandoned bootstrap reservation left auth state behind");
    }

    const reservation = await PostgresBaileysAuthBinding.reserveBootstrap(pool, {
      sessionKey: RESERVATION_SESSION,
      encryptionKey: KEY,
      encryptionKeyVersion: 1,
    });
    await reservation.commit({
      creds: { reservationMarker: Buffer.from("provider-connected") },
      keys: {
        "pre-key": {
          epsilon: Buffer.from([5, 4, 3, 2, 1]),
        },
      },
    });
    await expectReject(
      PostgresBaileysAuthBinding.open(pool, {
        sessionKey: RESERVATION_SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      }),
      WhatsAppAuthLeaseUnavailableError,
    );
    await reservation.close();

    const reservedAuth = await PostgresBaileysAuthBinding.open(pool, {
      sessionKey: RESERVATION_SESSION,
      encryptionKey: KEY,
      encryptionKeyVersion: 1,
    });
    const reservationMarker = reservedAuth.state.creds.reservationMarker;
    if (!Buffer.isBuffer(reservationMarker) || reservationMarker.toString("utf8") !== "provider-connected") {
      throw new Error("Reserved bootstrap credentials were not recovered exactly");
    }
    const reservedKeys = await reservedAuth.state.keys.get("pre-key", ["epsilon"]);
    if (!Buffer.isBuffer(reservedKeys.epsilon)) {
      throw new Error("Reserved bootstrap Signal key was not recovered exactly");
    }
    await reservedAuth.close();

    await expectReject(
      PostgresBaileysAuthBinding.reserveBootstrap(pool, {
        sessionKey: RESERVATION_SESSION,
        encryptionKey: KEY,
        encryptionKeyVersion: 1,
      }),
      WhatsAppAuthAlreadyBootstrappedError,
    );

    process.stdout.write("phase17 whatsapp auth proof passed\n");
  } finally {
    await pool.end();
  }
}

await main();
