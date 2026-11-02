import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ExpeditionCanonicalChoiceStagingResolver } from "../../src/modules/exploration/expedition-canonical-choice-staging.js";
import type { VerifiedExpeditionIssuedMenu } from "../../src/platform/exploration/postgres-expedition-issued-menu-reply-proof.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const senderRef = "5579999999999@s.whatsapp.net";
const outcomeId = randomUUID();
const encounterId = randomUUID();
const ballItemId = randomUUID();
const quote = randomUUID().replaceAll("-", "").toUpperCase();

function context(choice: string, quoted: string | null = quote): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    causationId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: "inbox:baileys:staging-immutable-choice",
    message: {
      provider: "baileys",
      externalMessageId: "staging-immutable-choice",
      senderRef,
      chatRef: senderRef,
      occurredAt: "2026-11-02T00:20:00.000Z",
      text: choice,
      replyToExternalMessageId: quoted,
      mediaRefs: [],
    },
  };
}

function setup() {
  const resolvePlayer = vi.fn(async () =>
    ok({ playerId, state: "COMPLETE" as const, created: false }),
  );
  const resolve = vi.fn(async () =>
    ok({ playerId, encounterId, outcomeId, encounterRevision: 2n }),
  );
  const activeForPlayer = vi.fn(async () =>
    ok({ playerId, encounterId, revision: 2n, status: "ENGAGED", battleId: null }),
  );
  const issuedResolve = vi.fn(
    async (): Promise<Result<VerifiedExpeditionIssuedMenu>> =>
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": ballItemId },
      }),
  );
  const attempt = vi.fn(
    async (): Promise<
      Result<{ status: "FAILED" | "CAPTURED"; replayed: boolean; encounterId: string }>
    > => ok({ status: "FAILED" as const, replayed: false, encounterId }),
  );
  const startCanonical = vi.fn(async () => ok({ start: { battleId: randomUUID() } }));
  const resolver = new ExpeditionCanonicalChoiceStagingResolver(
    { resolvePlayer } as unknown as ConstructorParameters<
      typeof ExpeditionCanonicalChoiceStagingResolver
    >[0],
    { resolve } as unknown as ConstructorParameters<
      typeof ExpeditionCanonicalChoiceStagingResolver
    >[1],
    { activeForPlayer } as unknown as ConstructorParameters<
      typeof ExpeditionCanonicalChoiceStagingResolver
    >[2],
    { resolve: issuedResolve } as unknown as ConstructorParameters<
      typeof ExpeditionCanonicalChoiceStagingResolver
    >[3],
    { attempt } as unknown as ConstructorParameters<
      typeof ExpeditionCanonicalChoiceStagingResolver
    >[4],
    { startCanonical } as unknown as ConstructorParameters<
      typeof ExpeditionCanonicalChoiceStagingResolver
    >[5],
  );
  return {
    resolver,
    resolvePlayer,
    resolve,
    activeForPlayer,
    issuedResolve,
    attempt,
    startCanonical,
  };
}

describe("staging canonical Capture/PvE mechanical command authorization", () => {
  it("does not interpret unquoted or unrelated numbers as commands", async () => {
    const fixture = setup();
    const router = new MessageRouter([], undefined, fixture.resolver);
    expect(await router.dispatch(context("2", null))).toEqual(ok(null));
    expect(await router.dispatch(context("0"))).toEqual(ok(null));
    expect(await router.dispatch(context("12"))).toEqual(ok(null));
    expect(fixture.attempt).not.toHaveBeenCalled();
    expect(fixture.startCanonical).not.toHaveBeenCalled();
  });

  it("fails closed for current READ_ONLY issuer even when it exposes a Ball mapping", async () => {
    const fixture = setup();
    const result = await fixture.resolver.resolve(context("2"));
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(fixture.attempt).not.toHaveBeenCalled();
    expect(fixture.startCanonical).not.toHaveBeenCalled();
  });

  it("uses only pinned Ball itemId and the inbound idempotency key when explicitly actionable", async () => {
    const fixture = setup();
    fixture.issuedResolve.mockResolvedValueOnce(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": ballItemId },
        actionable: true,
        captureEnabled: true,
        battleEnabled: false,
      }),
    );
    const routed = await new MessageRouter([], undefined, fixture.resolver).dispatch(context("2"));
    expect(routed).toMatchObject({ ok: true, value: { resultRefType: "ENCOUNTER" } });
    expect(fixture.attempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        playerId,
        encounterId,
        expectedEncounterRevision: 2n,
        expectedBattleVersion: null,
        ballItemId,
        idempotencyKey: "inbox:baileys:staging-immutable-choice",
      }),
    );
    expect(fixture.startCanonical).not.toHaveBeenCalled();
  });

  it("starts existing canonical PvE only if the issued panel explicitly permits BATTLE", async () => {
    const fixture = setup();
    fixture.issuedResolve.mockResolvedValueOnce(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: {},
        actionable: true,
        captureEnabled: false,
        battleEnabled: true,
      }),
    );
    const result = await fixture.resolver.resolve(context("1"));
    expect(result).toMatchObject({ ok: true, value: { resultRefType: "BATTLE" } });
    expect(fixture.startCanonical).toHaveBeenCalledExactlyOnceWith({
      playerId,
      encounterId,
      expectedRevision: 2n,
      status: "ENGAGED",
    });
    expect(fixture.attempt).not.toHaveBeenCalled();
  });

  it.each([
    { choice: "2", captureEnabled: false, battleEnabled: true },
    { choice: "1", captureEnabled: true, battleEnabled: false },
  ])("rejects choice $choice not allowed by server-issued capabilities", async (flags) => {
    const fixture = setup();
    fixture.issuedResolve.mockResolvedValueOnce(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": ballItemId },
        actionable: true,
        captureEnabled: flags.captureEnabled,
        battleEnabled: flags.battleEnabled,
      }),
    );
    expect(await fixture.resolver.resolve(context(flags.choice))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(fixture.attempt).not.toHaveBeenCalled();
    expect(fixture.startCanonical).not.toHaveBeenCalled();
  });

  it("rejects a menu with the wrong owner/outcome even when flagged ACTIONABLE", async () => {
    const fixture = setup();
    fixture.issuedResolve.mockResolvedValueOnce(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId: randomUUID(),
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": ballItemId },
        actionable: true,
        captureEnabled: true,
      }),
    );
    expect(await fixture.resolver.resolve(context("2"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(fixture.attempt).not.toHaveBeenCalled();
  });

  it("propagates canonical capture errors without pretending a Ball was spent", async () => {
    const fixture = setup();
    fixture.issuedResolve.mockResolvedValueOnce(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: { "2": ballItemId },
        actionable: true,
        captureEnabled: true,
      }),
    );
    fixture.attempt.mockResolvedValueOnce(
      err(appError("FLOW_BLOCKED", "Encounter revision changed")),
    );
    expect(await fixture.resolver.resolve(context("2"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
  });

  it("does not execute for a group, stale encounter or unregistered trainer", async () => {
    const fixture = setup();
    const group = context("2");
    expect(
      await fixture.resolver.resolve({
        ...group,
        message: { ...group.message, chatRef: "120363123456789@g.us" },
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(fixture.attempt).not.toHaveBeenCalled();
    expect(fixture.startCanonical).not.toHaveBeenCalled();
  });
});
