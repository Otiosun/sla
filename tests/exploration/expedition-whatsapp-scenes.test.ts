import { describe, expect, it } from "vitest";
import {
  advanceExpedition,
  type ExpeditionSnapshot,
} from "../../src/modules/exploration/expedition-state.js";
import {
  renderExpeditionCaptureResolutionScene,
  renderExpeditionDirectEncounterScene,
  privateExpeditionSceneReply,
  type ExpeditionPresentedEncounter,
} from "../../src/modules/exploration/expedition-whatsapp-scenes.js";
import {
  selectExpeditionMenuChoice,
  type ExpeditionMenuChoice,
} from "../../src/modules/exploration/expedition-contextual-menu.js";
import type { FirstActionOutcome } from "../../src/platform/exploration/postgres-expedition-first-action.js";
import type { CaptureAttemptResult } from "../../src/modules/capture/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
} from "../../src/modules/messaging/contracts.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = "00000000-0000-4000-8000-000000000001";
const areaId = "00000000-0000-4000-8000-000000000002";
const encounterId = "00000000-0000-4000-8000-000000000003";
const releaseId = "00000000-0000-4000-8000-000000000004";
const formId = "00000000-0000-4000-8000-000000000005";
const pokemonInstanceId = "00000000-0000-4000-8000-000000000006";

const choices: readonly ExpeditionMenuChoice[] = [
  { optionNo: 1, intent: "BATTLE", label: "Batalhar", phrases: ["batalhar"] },
  { optionNo: 2, intent: "CAPTURE", label: "Capturar", phrases: [] },
  { optionNo: 3, intent: "IGNORE_ENCOUNTER", label: "Ignorar", phrases: ["ignorar"] },
];

function firstAction(): FirstActionOutcome {
  const initial: ExpeditionSnapshot = {
    expeditionId: "expedition-synthetic",
    playerId: playerId as ExpeditionSnapshot["playerId"],
    areaId,
    currentAreaId: areaId,
    period: "DAY",
    phase: "PREPARING",
    elapsedMinutes: 0,
    consumedWeekKey: null,
    endReason: null,
    revision: 0n,
  };
  const transition = advanceExpedition({
    expedition: initial,
    expectedRevision: 0n,
    minutes: 30,
    weekKey: "2026-10-19",
    consumedThisWeek: 0,
  });
  if (!transition.ok) throw new Error("Synthetic domain fixture cannot advance");
  return {
    ...transition.value,
    changed: true,
    replayed: false,
    effectResult: {
      kind: "EXPEDITION_DIRECT_ENCOUNTER",
      encounterId,
      contentReleaseId: releaseId,
      areaId,
      entryId: "synthetic-entry",
      formId,
      level: 5,
      encounterStatus: "CREATED",
    },
  };
}

function observed(): ExpeditionPresentedEncounter {
  return {
    encounterId: encounterId as ExpeditionPresentedEncounter["encounterId"],
    playerId: playerId as ExpeditionPresentedEncounter["playerId"],
    areaId,
    contentReleaseId: releaseId,
    status: "PRESENTED",
    snapshot: {
      formId,
      speciesId: "synthetic-species",
      level: 5,
      shiny: false,
    } as ExpeditionPresentedEncounter["snapshot"],
  };
}

function captured(): Pick<
  CaptureAttemptResult,
  "encounterId" | "status" | "pokemonInstanceId" | "placement" | "replayed"
> {
  return {
    encounterId: encounterId as CaptureAttemptResult["encounterId"],
    status: "CAPTURED",
    pokemonInstanceId: pokemonInstanceId as CaptureAttemptResult["pokemonInstanceId"],
    placement: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
    replayed: false,
  };
}

describe("Rotom WhatsApp presentation from canonical, observed outcome (shadow only)", () => {
  it("formats an end-to-end synthetic search/encounter/capture transcript without invented rewards", () => {
    const action = firstAction();
    expect(action.consumedWeeklySlot).toBe(true);
    expect(action.expedition.elapsedMinutes).toBe(30);
    const encounter = renderExpeditionDirectEncounterScene({
      action,
      observed: observed(),
      speciesName: "Shroomish",
      locationName: "Campos de Yun",
      choices,
    });
    expect(encounter.ok).toBe(true);
    if (!encounter.ok) return;
    expect(encounter.value).toContain("Shroomish");
    expect(encounter.value).toContain("30 min");
    expect(encounter.value).toContain("690 min restantes");
    expect(encounter.value).toContain("1. Batalhar");
    expect(encounter.value).toContain("2. Capturar");
    expect(selectExpeditionMenuChoice({ text: "2", choices })).toMatchObject({
      ok: true,
      value: { intent: "CAPTURE", requiresServerActionAuthorization: true },
    });

    const capture = renderExpeditionCaptureResolutionScene({
      encounter: observed(),
      capture: captured(),
      speciesName: "Shroomish",
    });
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.value).toContain("capturado");
    expect(capture.value).toContain("Equipe · posição 2");
    const transcript = `${encounter.value}\n\n${capture.value}`;
    for (const secret of [encounterId, areaId, playerId, releaseId, formId, pokemonInstanceId]) {
      expect(transcript).not.toContain(secret);
    }
    expect(transcript).not.toMatch(/(?:XP|Pokédollars|ganhou.*Ball)/iu);
  });

  it("refuses to present CREATED as already observed", () => {
    expect(
      renderExpeditionDirectEncounterScene({
        action: firstAction(),
        observed: { ...observed(), status: "CREATED" },
        speciesName: "Shroomish",
        locationName: "Campos de Yun",
        choices,
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it.each(["encounterId", "contentReleaseId", "areaId", "formId", "level"] as const)(
    "fails closed if canonical receipt %s does not match the observed encounter",
    (property) => {
      const action = firstAction();
      const effectResult = {
        ...(action.effectResult as Record<string, unknown>),
        [property]: property === "level" ? 9 : "tampered",
      };
      expect(
        renderExpeditionDirectEncounterScene({
          action: { ...action, effectResult },
          observed: observed(),
          speciesName: "Shroomish",
          locationName: "Campos de Yun",
          choices,
        }),
      ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    },
  );

  it("blocks cross-player and cross-location presentations", () => {
    const action = firstAction();
    for (const mismatch of [
      { ...observed(), playerId: "another-player" as ExpeditionPresentedEncounter["playerId"] },
      { ...observed(), areaId: "another-area" },
    ]) {
      expect(
        renderExpeditionDirectEncounterScene({
          action,
          observed: mismatch,
          speciesName: "Shroomish",
          locationName: "Campos de Yun",
          choices,
        }).ok,
      ).toBe(false);
    }
  });

  it("does not offer capture/battle before a validated menu exists", () => {
    const scene = renderExpeditionDirectEncounterScene({
      action: firstAction(),
      observed: observed(),
      speciesName: "Shroomish",
      locationName: "Campos de Yun",
      choices: [],
    });
    expect(scene.ok).toBe(true);
    if (scene.ok) {
      expect(scene.value).toContain("não estão disponíveis");
      expect(scene.value).not.toContain("1. Batalhar");
    }
  });

  it("does not convert failed capture into successful Pokémon or XP grants", () => {
    const scene = renderExpeditionCaptureResolutionScene({
      encounter: observed(),
      capture: {
        ...captured(),
        status: "FAILED",
        pokemonInstanceId: null,
        placement: null,
      },
      speciesName: "Shroomish",
    });
    expect(scene.ok).toBe(true);
    if (scene.ok) {
      expect(scene.value).toContain("escapou");
      expect(scene.value).not.toContain("capturado");
      expect(scene.value).not.toContain("XP");
    }
  });

  it("rejects impossible or unrelated CaptureService results", () => {
    for (const capture of [
      { ...captured(), encounterId: "different" as CaptureAttemptResult["encounterId"] },
      { ...captured(), pokemonInstanceId: null },
      { ...captured(), placement: null },
      { ...captured(), placement: { placementKind: "BOX" as const, boxNo: 0, slotNo: 1 } },
      { ...captured(), status: "FAILED" as const },
    ]) {
      expect(
        renderExpeditionCaptureResolutionScene({
          encounter: observed(),
          capture,
          speciesName: "Shroomish",
        }).ok,
      ).toBe(false);
    }
  });

  it("sanitizes labels and blocks unsupported action menu intents", () => {
    const action = firstAction();
    const scene = renderExpeditionDirectEncounterScene({
      action,
      observed: observed(),
      speciesName: "*Shroomish*\n/administrar",
      locationName: "Campos/<> de Yun",
      choices: [],
    });
    expect(scene.ok).toBe(true);
    if (scene.ok) {
      expect(scene.value).not.toContain("*Shroomish*");
      expect(scene.value).not.toContain("\n/administrar");
      expect(scene.value).not.toContain("<>");
    }
    expect(
      renderExpeditionDirectEncounterScene({
        action,
        observed: observed(),
        speciesName: "Shroomish",
        locationName: "Campos de Yun",
        choices: [{ optionNo: 1, intent: "TRAVEL", label: "Teleportar", phrases: [] }],
      }).ok,
    ).toBe(false);
  });
  it("routes the confirmed scene through the real MessageRouter contract privately and idempotently", async () => {
    const router = new MessageRouter(
      [
        {
          command: "explorar",
          policy: { allowedPlayerAccess: ["ACTIVE"], requiresMechanicalReady: true },
          handler: {
            async handle(context) {
              const scene = renderExpeditionDirectEncounterScene({
                action: firstAction(),
                observed: observed(),
                speciesName: "Shroomish",
                locationName: "Campos de Yun",
                choices,
              });
              return privateExpeditionSceneReply(context, "encounter", observed().encounterId, scene);
            },
          },
        },
      ],
      { authorize: async () => ok(undefined) },
    );
    const message = IncomingMessageSchema.parse({
      provider: "baileys",
      externalMessageId: "shadow-encounter-message",
      senderRef: "trainer-private-jid",
      chatRef: "game-group-jid",
      occurredAt: "2026-10-25T17:00:00-03:00",
      text: "/explorar",
    });
    const context = {
      inboxMessageId: "00000000-0000-4000-8000-000000000011",
      correlationId: "00000000-0000-4000-8000-000000000012",
      causationId: "00000000-0000-4000-8000-000000000011",
      idempotencyKey: incomingMessageIdempotencyKey(message),
      message,
    };
    const first = await router.dispatch(context);
    const retry = await router.dispatch(context);
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    const outbound = first.value?.outgoing[0];
    expect(outbound).toMatchObject({
      channel: "whatsapp",
      destinationRef: "trainer-private-jid",
      messageType: "TEXT",
      idempotencyKey: "inbox:baileys:shadow-encounter-message:expedition-encounter",
    });
    expect(outbound?.payload.text).toContain("Shroomish");
    expect(first.value?.outgoing).toEqual(retry.value?.outgoing);
    expect(JSON.stringify(outbound?.payload)).not.toContain(encounterId);
    expect(first.value?.resultRefType).toBe("ENCOUNTER");
    expect(first.value?.resultRefId).toBe(encounterId);

    const failed = privateExpeditionSceneReply(
      context,
      "encounter",
      observed().encounterId,
      renderExpeditionDirectEncounterScene({
        action: firstAction(),
        observed: { ...observed(), status: "CREATED" },
        speciesName: "Shroomish",
        locationName: "Campos de Yun",
        choices,
      }),
    );
    expect(failed).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });
});
