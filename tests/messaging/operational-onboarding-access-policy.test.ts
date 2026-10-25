import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";

function context(command: string): MessageHandlerContext {
  return {
    inboxMessageId: "onboarding-policy-inbox",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "onboarding-policy-inbox",
    idempotencyKey: "onboarding-policy-action",
    message: {
      provider: "baileys",
      externalMessageId: "onboarding-policy-message",
      senderRef: "onboarding-shadow@s.whatsapp.net",
      chatRef: "onboarding-shadow@g.us",
      occurredAt: "2026-10-25T03:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function fixture(
  status: "ACTIVE" | "SUSPENDED" | "PENDING" | "PROVISIONING",
  state: "NEW" | "PROFILE_CREATED" | "COMPLETE" = "NEW",
  unknownIdentity = false,
) {
  const handlerResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const authResolve = vi.fn(async () =>
    unknownIdentity
      ? err(appError("NOT_FOUND", "No player linked to this sender"))
      : ok({ playerId: PLAYER_ID, state, created: false }),
  );
  const accessLoad = vi.fn(async () => ({
    playerId: PLAYER_ID,
    status,
    approvedReviewId: null,
    revision: 2,
  }));
  const resolveOrCreatePlayer = vi.fn(async () =>
    ok({ playerId: PLAYER_ID, state: "NEW", created: true }),
  );
  const createProfile = vi.fn(async () => ok({ playerId: PLAYER_ID, state: "PROFILE_CREATED" }));
  const listRegionOptions = vi.fn(async () => [
    { regionId: "region-kanto", displayName: "Kanto" },
  ]);
  const selectRegion = vi.fn(async () => ok({ playerId: PLAYER_ID, state: "REGION_SELECTED" }));
  const prepareStarterSelection = vi.fn(async () =>
    err(appError("FEATURE_UNAVAILABLE", "Fixture stopped after eligibility check")),
  );
  const completeOnboarding = vi.fn(async () =>
    err(appError("FEATURE_UNAVAILABLE", "Fixture stopped after eligibility check")),
  );
  const routes = createOperationalUxRoutes({
    registration: {
      resolvePlayer: handlerResolve,
      resolveOrCreatePlayer,
      createProfile,
      selectRegion,
    },
    starter: { prepareStarterSelection, completeOnboarding },
    reads: { listRegionOptions },
  } as never);
  const groupLookup = vi.fn(async () => ({
    known: false,
    groupId: null,
    role: null,
    capabilities: [],
  }));
  const gate = new RuntimeCommandPolicyGate({
    community: { resolveChat: groupLookup },
    players: { resolvePlayer: authResolve },
    access: { load: accessLoad },
    admins: { capabilitiesFor: vi.fn(async () => []) },
  } as never);
  return {
    routes,
    router: new MessageRouter(routes, gate),
    handlerResolve,
    authResolve,
    accessLoad,
    resolveOrCreatePlayer,
    createProfile,
    listRegionOptions,
    selectRegion,
    prepareStarterSelection,
    completeOnboarding,
    groupLookup,
  };
}

describe("legacy onboarding command permissions", () => {
  it("protects onboarding writes without requiring complete mechanics or a configured group", () => {
    const f = fixture("PENDING");
    for (const command of ["registrar", "regiao", "starter", "concluir"]) {
      const route = f.routes.find((candidate) => candidate.command === command);
      expect(route?.policy).toEqual({
        allowedPlayerAccess: ["PENDING", "PROVISIONING", "ACTIVE"],
      });
      expect(route?.policy?.requiresMechanicalReady).toBeUndefined();
      expect(route?.policy?.requiredGroupCapabilities).toBeUndefined();
    }
    for (const command of ["menu", "regioes", "starters", "perfil"]) {
      expect(f.routes.find((route) => route.command === command)?.policy).toBeUndefined();
    }
  });

  it("rejects SUSPENDED access before any onboarding mutation runs", async () => {
    const f = fixture("SUSPENDED");
    for (const command of ["/registrar Ash", "/regiao 1", "/starter 1", "/concluir"]) {
      const result = await f.router.dispatch(context(command));
      expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    }
    expect(f.authResolve).toHaveBeenCalledTimes(4);
    expect(f.accessLoad).toHaveBeenCalledTimes(4);
    expect(f.handlerResolve).not.toHaveBeenCalled();
    expect(f.resolveOrCreatePlayer).not.toHaveBeenCalled();
    expect(f.createProfile).not.toHaveBeenCalled();
    expect(f.listRegionOptions).not.toHaveBeenCalled();
    expect(f.selectRegion).not.toHaveBeenCalled();
    expect(f.prepareStarterSelection).not.toHaveBeenCalled();
    expect(f.completeOnboarding).not.toHaveBeenCalled();
    expect(f.groupLookup).not.toHaveBeenCalled();
  });

  it("allows initial registration when no player identity exists", async () => {
    const f = fixture("PENDING", "NEW", true);
    const result = await f.router.dispatch(context("/registrar Ash"));
    expect(result.ok).toBe(true);
    expect(f.resolveOrCreatePlayer).toHaveBeenCalledTimes(1);
    expect(f.createProfile).toHaveBeenCalledTimes(1);
    expect(f.accessLoad).not.toHaveBeenCalled();
    expect(f.groupLookup).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "PROVISIONING", "ACTIVE"] as const)(
    "keeps %s onboarding actions available before mechanical completion",
    async (status) => {
      const f = fixture(status, "PROFILE_CREATED");
      expect((await f.router.dispatch(context("/regiao 1"))).ok).toBe(true);
      expect(f.selectRegion).toHaveBeenCalledTimes(1);
      expect(await f.router.dispatch(context("/starter 1"))).toMatchObject({
        ok: false,
        error: { code: "FEATURE_UNAVAILABLE" },
      });
      expect(f.prepareStarterSelection).toHaveBeenCalledTimes(1);
      expect(await f.router.dispatch(context("/concluir"))).toMatchObject({
        ok: false,
        error: { code: "FEATURE_UNAVAILABLE" },
      });
      expect(f.completeOnboarding).toHaveBeenCalledTimes(1);
      expect(f.groupLookup).not.toHaveBeenCalled();
    },
  );

  it("leaves read-only registration help visible to suspended identities", async () => {
    const f = fixture("SUSPENDED", "COMPLETE");
    const result = await f.router.dispatch(context("/regioes"));
    expect(result.ok).toBe(true);
    expect(f.listRegionOptions).toHaveBeenCalledTimes(1);
    expect(f.accessLoad).not.toHaveBeenCalled();
  });
});
