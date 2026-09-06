import { describe, expect, it } from "vitest";
import { redactLogContext } from "../../src/platform/logging/index.js";

describe("structured logging redaction", () => {
  it("redacts compound credential keys without erasing operational identifiers", () => {
    expect(
      redactLogContext({
        correlationId: "corr-123",
        principalId: "principal-123",
        environment: "staging",
        tokenFingerprint: "fingerprint-secret",
        accessToken: "access-token-secret",
        clientSecret: "client-secret",
        cfAccessJwtAssertion: "jwt-assertion-secret",
        databaseUrl: "postgres://admin:password@db.example.test/pokemon",
        connectionString: "postgres://admin:password@db.example.test/pokemon",
        privateKey: "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----",
        whatsappAuthKeyBase64: "base64-auth-key-secret",
        nested: {
          webhookSecret: "webhook-secret",
          clientToken: "client-token-secret",
        },
      }),
    ).toEqual({
      correlationId: "corr-123",
      principalId: "principal-123",
      environment: "staging",
      tokenFingerprint: "[REDACTED]",
      accessToken: "[REDACTED]",
      clientSecret: "[REDACTED]",
      cfAccessJwtAssertion: "[REDACTED]",
      databaseUrl: "[REDACTED]",
      connectionString: "[REDACTED]",
      privateKey: "[REDACTED]",
      whatsappAuthKeyBase64: "[REDACTED]",
      nested: {
        webhookSecret: "[REDACTED]",
        clientToken: "[REDACTED]",
      },
    });
  });

  it("still redacts bearer credentials and phone-like values in free text", () => {
    expect(
      redactLogContext({
        message: "upstream rejected Bearer abc.def.ghi for 5511999999999",
      }),
    ).toEqual({
      message: "upstream rejected Bearer [REDACTED] for [REDACTED_PHONE]",
    });
  });
});
