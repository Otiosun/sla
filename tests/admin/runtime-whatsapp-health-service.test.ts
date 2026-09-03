import { describe, expect, it, vi } from "vitest";
import { AdminOperationRegistry } from "../../src/modules/admin/operation-registry.js";
import { registerRuntimeWhatsappHealthRead } from "../../src/modules/admin/runtime-health-definitions.js";
import { RuntimeWhatsappHealthService } from "../../src/modules/admin/runtime-health-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

const latestRuntime = {
  providerState: "CONNECTED" as const,
  deploymentRevision: "deploy-abc123",
  startedAt: new Date("2026-09-01T06:00:00.000Z"),
  lastConnectedAt: new Date("2026-09-01T06:00:10.000Z"),
  lastHeartbeatAt: new Date("2026-09-01T06:04:30.000Z"),
  lastDisconnectAt: null,
  stoppedAt: null,
};

describe("RuntimeWhatsappHealthService", () => {
  it("authorizes a global RUNTIME read and returns only the latest safe runtime summary", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "RUNTIME", id: null }));
    const findLatest = vi.fn(async () => latestRuntime);
    const service = new RuntimeWhatsappHealthService({ authorizeRead }, { findLatest });

    const result = await service.getLatest({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "runtime.whatsapp.health.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(findLatest).toHaveBeenCalledWith("staging");
    expect(result).toEqual({
      environment: "staging",
      runtime: {
        providerState: "CONNECTED",
        deploymentRevision: "deploy-abc123",
        startedAt: "2026-09-01T06:00:00.000Z",
        lastConnectedAt: "2026-09-01T06:00:10.000Z",
        lastHeartbeatAt: "2026-09-01T06:04:30.000Z",
        lastDisconnectAt: null,
        stoppedAt: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("whatsapp_session_key");
    expect(JSON.stringify(result)).not.toContain("shutdown_reason");
  });

  it("returns an explicit empty development state without querying production runtime evidence", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "RUNTIME", id: null }));
    const findLatest = vi.fn();
    const service = new RuntimeWhatsappHealthService({ authorizeRead }, { findLatest });

    const result = await service.getLatest({
      principalId: PRINCIPAL_ID,
      environment: "development",
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledOnce();
    expect(findLatest).not.toHaveBeenCalled();
    expect(result).toEqual({ environment: "development", runtime: null });
  });
});

describe("runtime WhatsApp health Registry definition", () => {
  it("is a zero-risk global READ over the RUNTIME target", () => {
    const registry = registerRuntimeWhatsappHealthRead(new AdminOperationRegistry());
    const definition = registry.require("runtime.whatsapp.health.read");

    expect(definition.kind).toBe("READ");
    expect(definition.capabilityKey).toBe("runtime.health.read");
    expect(definition.riskTier).toBe(0);
    expect(definition.authorizationMode).toBe("GLOBAL_ONLY");
    expect(definition.target({})).toEqual({ type: "RUNTIME", id: null });
  });
});
