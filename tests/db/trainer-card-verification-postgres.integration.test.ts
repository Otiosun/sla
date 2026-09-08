import { generateKeyPairSync } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Ed25519TrainerCardSigner,
  Ed25519TrainerCardVerifier,
  TrainerCardVerificationService,
  type TrainerCardPublicSnapshot,
} from "../../src/modules/verification/trainer-card-verification.js";
import { PostgresTrainerCardVerificationRepository } from "../../src/platform/verification/postgres-trainer-card-verification-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const PUBLIC_ID = "tcv_7Qm2Yp9Kx4Nw8Vr6Hs3Df1Za";
const KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "der", type: "pkcs8" },
  publicKeyEncoding: { format: "der", type: "spki" },
});
const SNAPSHOT: TrainerCardPublicSnapshot = {
  version: 1,
  trainerName: "Red",
  trainerTitle: "Treinador de Kanto",
  originRegion: "Kanto",
  currentLocation: "Route 1",
  leadPokemon: { dex: 25, nickname: "Pikachu" },
  earnedBadgeKeys: ["boulder", "cascade"],
  issuedAt: "2026-09-07T22:00:00.000Z",
};

describe.sequential("PostgresTrainerCardVerificationRepository", () => {
  const dbName = `pokemon_trainer_verification_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresTrainerCardVerificationRepository;
  const signer = new Ed25519TrainerCardSigner(KEY_PAIR.privateKey);
  const verifier = new Ed25519TrainerCardVerifier(KEY_PAIR.publicKey);

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "trainer-card-verification-proof" });
    repository = new PostgresTrainerCardVerificationRepository(pool);

    await pool.query(
      `INSERT INTO trainer_card_verifications (
         public_id,
         status,
         snapshot,
         signature,
         signature_algorithm,
         issued_at
       ) VALUES ($1, 'ACTIVE', $2::jsonb, $3, 'ED25519', $4::timestamptz)`,
      [PUBLIC_ID, JSON.stringify(SNAPSHOT), signer.sign(SNAPSHOT), SNAPSHOT.issuedAt],
    );
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

  it("loads the immutable signed public snapshot without private identity data", async () => {
    const record = await repository.findByPublicId(PUBLIC_ID);

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      publicId: PUBLIC_ID,
      status: "ACTIVE",
      snapshot: SNAPSHOT,
      revokedAt: null,
    });
    expect(JSON.stringify(record)).not.toContain("playerId");
    expect(JSON.stringify(record)).not.toContain("whatsapp");
    expect(JSON.stringify(record)).not.toContain("externalId");
  });

  it("rejects direct mutation of signed identity, snapshot, signature, algorithm, and issue time", async () => {
    const forbiddenUpdates = [
      ["public_id", "tcv_Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8"],
      ["snapshot", JSON.stringify({ ...SNAPSHOT, trainerName: "Mallory" })],
      ["signature", `ed25519:${"A".repeat(86)}`],
      ["signature_algorithm", "NONE"],
      ["issued_at", "2026-09-07T23:00:00.000Z"],
    ] as const;

    for (const [column, value] of forbiddenUpdates) {
      await expect(
        pool.query(`UPDATE trainer_card_verifications SET ${column} = $1 WHERE public_id = $2`, [
          value,
          PUBLIC_ID,
        ]),
      ).rejects.toThrow();
    }

    const service = new TrainerCardVerificationService(repository, verifier);
    await expect(service.verify(PUBLIC_ID)).resolves.toMatchObject({ status: "VALID" });
  });

  it("permits only ACTIVE to REVOKED and never exposes the revoked snapshot", async () => {
    const revokedAt = new Date("2026-09-07T23:30:00.000Z");
    await repository.revoke(PUBLIC_ID, revokedAt);

    const service = new TrainerCardVerificationService(repository, verifier);
    await expect(service.verify(PUBLIC_ID)).resolves.toEqual({
      status: "REVOKED",
      publicId: PUBLIC_ID,
    });

    await expect(
      pool.query(
        `UPDATE trainer_card_verifications
         SET status = 'ACTIVE', revoked_at = NULL
         WHERE public_id = $1`,
        [PUBLIC_ID],
      ),
    ).rejects.toThrow();

    await expect(repository.revoke(PUBLIC_ID, new Date("2026-09-08T00:00:00.000Z"))).resolves.toBe(
      false,
    );
  });

  it("rejects deletion so verification tombstones remain auditable", async () => {
    await expect(
      pool.query("DELETE FROM trainer_card_verifications WHERE public_id = $1", [PUBLIC_ID]),
    ).rejects.toThrow();
  });
});
