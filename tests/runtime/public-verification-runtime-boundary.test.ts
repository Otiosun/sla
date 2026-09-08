import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HmacTrainerCardSigner,
  type TrainerCardPublicSnapshot,
} from "../../src/modules/verification/trainer-card-verification.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresTrainerCardVerificationRepository } from "../../src/platform/verification/postgres-trainer-card-verification-repository.js";
import { createOperationalPublicVerificationApi } from "../../src/runtime/compose-public-verification.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for public verification runtime tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const PUBLIC_ID = "tcv_Rt7Yp2Qa9Lm4Nx8Vk3Hs6Df1";
const SIGNING_KEY = new Uint8Array(32).fill(17);
const RATE_LIMIT_PEPPER = new Uint8Array(32).fill(23);
const SNAPSHOT: TrainerCardPublicSnapshot = {
  version: 1,
  trainerName: "Leaf",
  trainerTitle: "Treinadora de Kanto",
  originRegion: "Kanto",
  currentLocation: "Pallet Town",
  leadPokemon: { dex: 1, nickname: "Bulbasaur" },
  earnedBadgeKeys: ["boulder"],
  issuedAt: "2026-09-08T00:00:00.000Z",
};

describe.sequential("public verification runtime boundary", () => {
  const dbName = `pokemon_public_verification_runtime_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "public-verification-runtime-proof" });

    const signer = new HmacTrainerCardSigner(SIGNING_KEY);
    const repository = new PostgresTrainerCardVerificationRepository(pool);
    await repository.issue({
      publicId: PUBLIC_ID,
      status: "ACTIVE",
      snapshot: SNAPSHOT,
      signature: signer.sign(SNAPSHOT),
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

  it("composes the GET-only public verifier from PostgreSQL without Admin API or WhatsApp authority", async () => {
    const api = createOperationalPublicVerificationApi(pool, {
      host: "127.0.0.1",
      port: 18_787,
      signingKey: SIGNING_KEY,
      rateLimitPepper: RATE_LIMIT_PEPPER,
      rateLimitPolicy: { limit: 10, peerLimit: 20, windowSeconds: 60 },
    });

    const response = await api.server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "VALID", publicId: PUBLIC_ID, snapshot: SNAPSHOT });

    const mutationAttempt = await api.server.inject({
      method: "POST",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
    });
    expect(mutationAttempt.statusCode).toBe(404);

    await api.close();
  });

  it("keeps the public listener in a dedicated entrypoint instead of opening the WhatsApp worker", async () => {
    const workerMain = await readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
    const publicMain = await readFile(
      new URL("../../src/public-verification-main.ts", import.meta.url),
      "utf8",
    );

    expect(workerMain).not.toContain("createOperationalPublicVerificationApi");
    expect(workerMain).not.toContain("PUBLIC_VERIFICATION_PORT");
    expect(publicMain).toContain("createOperationalPublicVerificationApi");
    expect(publicMain).toContain("PUBLIC_VERIFICATION_PORT");
  });
});
