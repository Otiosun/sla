import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createPublicVerificationServer } from "../adapters/public-api/fastify-server.js";
import {
  HmacTrainerCardSigner,
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
  readonly signingKey: Uint8Array;
  readonly rateLimitPepper: Uint8Array;
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
  const signer = new HmacTrainerCardSigner(config.signingKey);
  const verificationService = new TrainerCardVerificationService(repository, signer);
  const rateLimiter = new PostgresPublicVerificationRateLimiter(
    pool,
    config.rateLimitPepper,
    config.rateLimitPolicy,
  );
  const server = createPublicVerificationServer({ verificationService, rateLimiter });

  return {
    server,
    listen: () => server.listen({ host: config.host, port: config.port }),
    close: () => server.close(),
  };
}
