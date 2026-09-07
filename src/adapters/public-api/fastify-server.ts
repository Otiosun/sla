import Fastify, { type FastifyInstance } from "fastify";
import type { TrainerCardVerificationResult } from "../../modules/verification/trainer-card-verification.js";

export interface PublicVerificationService {
  verify(publicId: string): Promise<TrainerCardVerificationResult>;
}

export interface PublicVerificationRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface PublicVerificationRateLimiter {
  consume(request: {
    readonly publicId: string;
    readonly remoteAddress: string;
  }): Promise<PublicVerificationRateLimitDecision>;
}

export interface PublicVerificationServerDependencies {
  readonly verificationService: PublicVerificationService;
  readonly rateLimiter: PublicVerificationRateLimiter;
}

const PUBLIC_ID_PATTERN = /^tcv_[A-Za-z0-9]{24}$/;

export function createPublicVerificationServer(
  dependencies: PublicVerificationServerDependencies,
): FastifyInstance {
  const server = Fastify({ logger: false });

  server.addHook("onSend", async (_request, reply, payload) => {
    void reply.header("cache-control", "no-store");
    void reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  server.get<{ Params: { publicId: string } }>(
    "/public/v1/trainer-cards/:publicId/verify",
    async (request, reply) => {
      const { publicId } = request.params;
      const rateLimit = await dependencies.rateLimiter.consume({
        publicId,
        remoteAddress: request.ip,
      });

      if (!rateLimit.allowed) {
        void reply.header("retry-after", String(Math.max(1, Math.ceil(rateLimit.retryAfterSeconds))));
        return reply.code(429).send({ error: { code: "PUBLIC_RATE_LIMITED" } });
      }

      if (!PUBLIC_ID_PATTERN.test(publicId)) {
        return reply.send({ status: "INVALID" });
      }

      try {
        return reply.send(await dependencies.verificationService.verify(publicId));
      } catch {
        return reply.code(500).send({ error: { code: "PUBLIC_VERIFICATION_FAILED" } });
      }
    },
  );

  return server;
}
