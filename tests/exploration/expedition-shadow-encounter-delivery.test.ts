import { describe, expect, it, vi } from "vitest";
import type { EncounterView } from "../../src/modules/encounter/contracts.js";
import { presentCommittedExpeditionDirectEncounter } from "../../src/modules/exploration/expedition-shadow-encounter-delivery.js";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import type { FirstActionOutcome } from "../../src/platform/exploration/postgres-expedition-first-action.js";
import type { PlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const trainer = "00000000-0000-4000-8000-000000000001" as PlayerId;
const encounterId = "00000000-0000-4000-8000-000000000003";
const areaId = "00000000-0000-4000-8000-000000000002";
const formId = "00000000-0000-4000-8000-000000000005";
const releaseId = "00000000-0000-4000-8000-000000000004";

function action(): FirstActionOutcome {
  return {
    expedition: {
      expeditionId: "expedition-fixture",
      playerId: trainer,
      areaId,
      currentAreaId: areaId,
      period: "DAY",
      phase: "ACTIVE",
      elapsedMinutes: 30,
      consumedWeekKey: "2026-10-19",
      endReason: null,
      revision: 1n,
    },
    consumedWeeklySlot: true,
    changed: true,
    replayed: false,
    effectResult: {
      kind: "EXPEDITION_DIRECT_ENCOUNTER",
      encounterId,
      contentReleaseId: releaseId,
      areaId,
      entryId: "synthetic-published-table-entry",
      formId,
      level: 5,
      encounterStatus: "CREATED",
    },
  };
}

function view(status: EncounterView["status"], revision = 0n): EncounterView {
  return {
    encounterId,
    playerId: trainer,
    areaId,
    contentReleaseId: releaseId,
    status,
    revision,
    snapshot: {
      speciesId: "synthetic-shroomish-species",
      formId,
      level: 5,
      shiny: false,
    },
  } as EncounterView;
}

function context(): MessageHandlerContext {
  const message = IncomingMessageSchema.parse({
    provider: "baileys",
    externalMessageId: "shadow-hunt-message",
    senderRef: "trainer-private-jid",
    chatRef: "group-jid",
    occurredAt: "2026-10-25T17:00:00-03:00",
    text: "/explorar buscar",
  });
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000011",
    correlationId: "00000000-0000-4000-8000-000000000012",
    causationId: "00000000-0000-4000-8000-000000000011",
    idempotencyKey: incomingMessageIdempotencyKey(message),
    message,
  };
}

function harness(status: EncounterView["status"] = "CREATED") {
  const encounter = {
    get: vi.fn().mockResolvedValue(ok(view(status))),
    observe: vi.fn().mockResolvedValue(ok(view("PRESENTED", 1n))),
  };
  const labels = {
    species: vi.fn().mockResolvedValue("Shroomish"),
    area: vi.fn().mockResolvedValue("Campos de Yun"),
  };
  return { encounter, labels };
}

describe("post-commit isolated Expedition → Encounter observe → private WhatsApp", () => {
  it("observes the committed encounter before formatting its private reply", async () => {
    const deps = harness();
    const response = await presentCommittedExpeditionDirectEncounter(
      context(),
      trainer,
      action(),
      deps,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(deps.encounter.observe).toHaveBeenCalledWith({
      playerId: trainer,
      encounterId,
      expectedRevision: 0n,
    });
    expect(deps.labels.species).toHaveBeenCalledWith(
      releaseId,
      "synthetic-shroomish-species",
    );
    expect(deps.labels.area).toHaveBeenCalledWith(releaseId, areaId);
    expect(response.value).toMatchObject({
      resultRefType: "ENCOUNTER",
      resultRefId: encounterId,
      outgoing: [
        {
          destinationRef: "trainer-private-jid",
          messageType: "TEXT",
          idempotencyKey:
            "inbox:baileys:shadow-hunt-message:expedition-encounter",
        },
      ],
    });
    const message = String(response.value.outgoing[0]?.payload.text);
    expect(message).toContain("Shroomish");
    expect(message).toContain("690 min restantes");
    expect(message).toContain("não estão disponíveis");
    expect(message).not.toContain(encounterId);
    expect(message).not.toContain(areaId);
  });

  it("does not observe a second time or change the private reply on replay", async () => {
    const deps = harness("PRESENTED");
    const first = await presentCommittedExpeditionDirectEncounter(
      context(),
      trainer,
      action(),
      deps,
    );
    const second = await presentCommittedExpeditionDirectEncounter(
      context(),
      trainer,
      action(),
      deps,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(deps.encounter.observe).not.toHaveBeenCalled();
    expect(first.value.outgoing).toEqual(second.value.outgoing);
  });

  it("never reports CREATED on failed canonical observation", async () => {
    const deps = harness();
    deps.encounter.observe.mockResolvedValue(
      err(appError("REVISION_CONFLICT", "Encounter changed")),
    );
    const result = await presentCommittedExpeditionDirectEncounter(
      context(),
      trainer,
      action(),
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(deps.labels.species).not.toHaveBeenCalled();
  });

  it("fails closed for an unrelated receipt, user, catalog or terminal encounter", async () => {
    const wrongAction = { ...action(), effectResult: { kind: "NO_SIGNAL" } };
    const wrongTrainer = "00000000-0000-4000-8000-000000000099" as PlayerId;
    for (const [playerId, input] of [
      [trainer, wrongAction],
      [wrongTrainer, action()],
    ] as const) {
      const deps = harness();
      const result = await presentCommittedExpeditionDirectEncounter(
        context(),
        playerId,
        input,
        deps,
      );
      expect(result.ok).toBe(false);
      expect(deps.encounter.get).not.toHaveBeenCalled();
    }
    const noLabel = harness();
    noLabel.labels.species.mockResolvedValue(null);
    expect(
      (
        await presentCommittedExpeditionDirectEncounter(
          context(),
          trainer,
          action(),
          noLabel,
        )
      ).ok,
    ).toBe(false);
    const terminal = harness("CAPTURED");
    expect(
      (
        await presentCommittedExpeditionDirectEncounter(
          context(),
          trainer,
          action(),
          terminal,
        )
      ).ok,
    ).toBe(false);
    expect(terminal.encounter.observe).not.toHaveBeenCalled();
  });
});
