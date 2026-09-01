import { describe, expect, it, vi } from "vitest";
import { IncidentCenterReadService } from "../../src/modules/admin/incident-center-read-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

const evidence = [
  {
    source: "OUTBOX" as const,
    id: "33333333-3333-4333-8333-333333333333",
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "DEAD" as const,
    kind: "OUTBOX_MESSAGE",
    targetType: null,
    targetId: null,
    riskTier: null,
    attempts: 8,
    occurredAt: new Date("2026-09-01T13:00:00.000Z"),
  },
  {
    source: "ADMIN_OPERATION" as const,
    id: "44444444-4444-4444-8444-444444444444",
    correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "FAILED" as const,
    kind: "player.profile.edit",
    targetType: "PLAYER",
    targetId: "55555555-5555-4555-8555-555555555555",
    riskTier: 2,
    attempts: null,
    occurredAt: new Date("2026-09-01T12:30:00.000Z"),
  },
];

describe("IncidentCenterReadService", () => {
  it("authorizes the incident read and returns correlated failure metadata plus static guidance only", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "RUNTIME", id: null }));
    const readRecent = vi.fn(async () => evidence);
    const service = new IncidentCenterReadService({ authorizeRead }, { readRecent });

    const result = await service.getSnapshot({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "incident.center.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(readRecent).toHaveBeenCalledWith(25);
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0]).toMatchObject({
      ...evidence[0],
      occurredAt: "2026-09-01T13:00:00.000Z",
      runbook: {
        key: "outbox-dead-letter",
        title: "Mensagem em dead-letter",
      },
    });
    expect(result.signals[1]).toMatchObject({
      ...evidence[1],
      occurredAt: "2026-09-01T12:30:00.000Z",
      runbook: {
        key: "admin-operation-failed",
        title: "Falha em operação administrativa",
      },
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "reason",
      "input",
      "result",
      "payload",
      "normalized_payload",
      "destination_ref",
      "external_message_id",
      "last_error_code",
      "causation_id",
      "retryEndpoint",
      "replayEndpoint",
      "requeueEndpoint",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
