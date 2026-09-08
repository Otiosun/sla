import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createPublicVerificationServer } from "../adapters/public-api/fastify-server.js";
import {
  Ed25519TrainerCardKeyringVerifier,
  TrainerCardVerificationService,
} from "../modules/verification/trainer-card-verification.js";
import {
  PostgresPublicVerificationRateLimiter,
  type PublicVerificationRateLimitPolicy,
} from "../platform/verification/postgres-public-verification-rate-limiter.js";
import { PostgresTrainerCardVerificationRepository } from "../platform/verification/postgres-trainer-card-verification-repository.js";

export interface PublicVerificationRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly publicKey: Uint8Array;
  readonly previousPublicKeys?: readonly Uint8Array[];
  readonly rateLimitPepper: Uint8Array;
  readonly trustedProxyCidrs?: readonly string[];
  readonly rateLimitPolicy: PublicVerificationRateLimitPolicy;
}

export interface OperationalPublicVerificationApi {
  readonly server: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function createOperationalPublicVerificationApi(
  pool: Pool,
  config: PublicVerificationRuntimeConfig,
): OperationalPublicVerificationApi {
  const repository = new PostgresTrainerCardVerificationRepository(pool);
  const verifier = new Ed25519TrainerCardKeyringVerifier(
    config.publicKey,
    config.previousPublicKeys ?? [],
  );
  const verificationService = new TrainerCardVerificationService(repository, verifier);
  const rateLimiter = new PostgresPublicVerificationRateLimiter(
    pool,
    config.rateLimitPepper,
    config.rateLimitPolicy,
  );
  const server = createPublicVerificationServer(
    { verificationService, rateLimiter },
    { trustedProxyCidrs: config.trustedProxyCidrs ?? [] },
  );

  return {
    server,
    listen: () => server.listen({ host: config.host, port: config.port }),
    close: () => server.close(),
  };
}
