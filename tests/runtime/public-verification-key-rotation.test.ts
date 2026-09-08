import { generateKeyPairSync } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Ed25519TrainerCardSigner,
  type TrainerCardPublicSnapshot,
} from "../../src/modules/verification/trainer-card-verification.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresTrainerCardVerificationRepository } from "../../src/platform/verification/postgres-trainer-card-verification-repository.js";
import { createOperationalPublicVerificationApi } from "../../src/runtime/compose-public-verification.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for public verification key-rotation tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function keyPair() {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
}

const PREVIOUS_KEY_PAIR = keyPair();
const CURRENT_KEY_PAIR = keyPair();
const UNKNOWN_KEY_PAIR = keyPair();
const PREVIOUS_PUBLIC_ID = "tcv_AbCdEfGhIjKlMnOpQrStUvWx";
const CURRENT_PUBLIC_ID = "tcv_Yz0123456789AaBbCcDdEeFf";
const UNKNOWN_PUBLIC_ID = "tcv_GhIjKlMnOpQrStUvWxYz0123";
const RATE_LIMIT_PEPPER = new Uint8Array(32).fill(29);

function snapshot(trainerName: string, issuedAt: string): TrainerCardPublicSnapshot {
  return {
    version: 1,
    trainerName,
    trainerTitle: "Treinador Verificado",
    originRegion: "Kanto",
    currentLocation: "Viridian City",
    leadPokemon: { dex: 25, nickname: "Pikachu" },
    earnedBadgeKeys: ["boulder"],
    issuedAt,
  };
}

const PREVIOUS_SNAPSHOT = snapshot("Red", "2026-09-08T00:00:00.000Z");
const CURRENT_SNAPSHOT = snapshot("Leaf", "2026-09-08T01:00:00.000Z");
const UNKNOWN_SNAPSHOT = snapshot("Blue", "2026-09-08T02:00:00.000Z");

describe.sequential("public verification Ed25519 key rotation", () => {
  const dbName = `pokemon_public_verification_key_rotation_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "public-verification-key-rotation-proof" });

    const repository = new PostgresTrainerCardVerificationRepository(pool);
    const previousSigner = new Ed25519TrainerCardSigner(PREVIOUS_KEY_PAIR.privateKey);
    const currentSigner = new Ed25519TrainerCardSigner(CURRENT_KEY_PAIR.privateKey);
    const unknownSigner = new Ed25519TrainerCardSigner(UNKNOWN_KEY_PAIR.privateKey);

    await repository.issue({
      publicId: PREVIOUS_PUBLIC_ID,
      status: "ACTIVE",
      snapshot: PREVIOUS_SNAPSHOT,
      signature: previousSigner.sign(PREVIOUS_SNAPSHOT),
    });
    await repository.issue({
      publicId: CURRENT_PUBLIC_ID,
      status: "ACTIVE",
      snapshot: CURRENT_SNAPSHOT,
      signature: currentSigner.sign(CURRENT_SNAPSHOT),
    });
    await repository.issue({
      publicId: UNKNOWN_PUBLIC_ID,
      status: "ACTIVE",
      snapshot: UNKNOWN_SNAPSHOT,
      signature: unknownSigner.sign(UNKNOWN_SNAPSHOT),
    });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("keeps active cards valid across a bounded public-key rotation without accepting unknown keys", async () => {
    const config = {
      host: "127.0.0.1",
      port: 18_786,
      publicKey: CURRENT_KEY_PAIR.publicKey,
      previousPublicKeys: [PREVIOUS_KEY_PAIR.publicKey],
      rateLimitPepper: RATE_LIMIT_PEPPER,
      rateLimitPolicy: { limit: 10, peerLimit: 20, windowSeconds: 60 },
    } as Parameters<typeof createOperationalPublicVerificationApi>[1] & {
      readonly previousPublicKeys: readonly Uint8Array[];
    };
    const api = createOperationalPublicVerificationApi(pool, config);

    const previous = await api.server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PREVIOUS_PUBLIC_ID}/verify`,
    });
    expect(previous.statusCode).toBe(200);
    expect(previous.json()).toEqual({
      status: "VALID",
      publicId: PREVIOUS_PUBLIC_ID,
      snapshot: PREVIOUS_SNAPSHOT,
    });

    const current = await api.server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${CURRENT_PUBLIC_ID}/verify`,
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({
      status: "VALID",
      publicId: CURRENT_PUBLIC_ID,
      snapshot: CURRENT_SNAPSHOT,
    });

    const unknown = await api.server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${UNKNOWN_PUBLIC_ID}/verify`,
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ status: "INVALID" });

    await api.close();
  });
});
