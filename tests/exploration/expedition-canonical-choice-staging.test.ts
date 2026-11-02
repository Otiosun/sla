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

function setup(battleExecute?: ReturnType<typeof vi.fn>) {
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
    undefined,
    undefined,
    undefined,
    battleExecute === undefined ? undefined : { execute: battleExecute },
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
  it("reconstructs committed PvE confirmation without rerunning battle admission", async () => {
    const fixture = setup();
    const execute = vi.fn(async () => {
      throw new Error("No second battle may start during receipt recovery");
    });
    const read = vi.fn(async () => ok({ battleId: randomUUID() }));
    const gateway = new ExpeditionCanonicalChoiceStagingResolver(
      { resolvePlayer: fixture.resolvePlayer } as never,
      { resolve: fixture.resolve } as never,
      { activeForPlayer: fixture.activeForPlayer } as never,
      { resolve: fixture.issuedResolve } as never,
      { attempt: fixture.attempt } as never,
      { startCanonical: fixture.startCanonical } as never,
      undefined,
      undefined,
      undefined,
      { execute },
      { resolve: read },
    );
    const result = await gateway.resolve(context("1"));
    expect(result).toMatchObject({ ok: true, value: { resultRefType: "BATTLE" } });
    expect(read).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.issuedResolve).not.toHaveBeenCalled();
  });

  it("recovers committed ignore confirmation without issuing a second flee", async () => {
    const fixture = setup();
    const previous = { encounterId, elapsedMinutes: 40 };
    const ignoreExecute = vi.fn(async () => {
      throw new Error("Committed ignore may not be executed twice");
    });
    const ignoreRecovery = vi.fn(async () => ok(previous));
    const resolver = new ExpeditionCanonicalChoiceStagingResolver(
      { resolvePlayer: fixture.resolvePlayer } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[0],
      { resolve: fixture.resolve } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[1],
      { activeForPlayer: fixture.activeForPlayer } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[2],
      { resolve: fixture.issuedResolve } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[3],
      { attempt: fixture.attempt } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[4],
      { startCanonical: fixture.startCanonical } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[5],
      undefined,
      { execute: ignoreExecute } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[7],
      { resolve: ignoreRecovery },
    );
    expect(await resolver.resolve(context("0"))).toMatchObject({
      ok: true,
      value: {
        resultRefType: "ENCOUNTER",
        resultRefId: encounterId,
        outgoing: [{ payload: { text: expect.stringContaining("Total: 40min") } }],
      },
    });
    expect(ignoreRecovery).toHaveBeenCalledOnce();
    expect(ignoreExecute).not.toHaveBeenCalled();
    expect(fixture.issuedResolve).not.toHaveBeenCalled();
    expect(fixture.activeForPlayer).not.toHaveBeenCalled();
  });

  it("uses canonical 10-minute ignore only for exact quoted ACTIONABLE permission", async () => {
    const fixture = setup();
    const ignoreExecute = vi.fn(async () =>
      ok({ expedition: { elapsedMinutes: 40, phase: "ACTIVE" }, replayed: false }),
    );
    const withIgnore = new ExpeditionCanonicalChoiceStagingResolver(
      { resolvePlayer: fixture.resolvePlayer } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[0],
      { resolve: fixture.resolve } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[1],
      { activeForPlayer: fixture.activeForPlayer } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[2],
      { resolve: fixture.issuedResolve } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[3],
      { attempt: fixture.attempt } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[4],
      { startCanonical: fixture.startCanonical } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[5],
      undefined,
      { execute: ignoreExecute } as unknown as ConstructorParameters<
        typeof ExpeditionCanonicalChoiceStagingResolver
      >[7],
    );
    fixture.issuedResolve.mockResolvedValue(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: {},
        actionable: true,
        captureEnabled: false,
        battleEnabled: false,
        ignoreEnabled: true,
      }),
    );
    expect(await withIgnore.resolve(context("0"))).toMatchObject({
      ok: true,
      value: {
        resultRefType: "ENCOUNTER",
        outgoing: [{ payload: { text: expect.stringContaining("10 minutos") } }],
      },
    });
    expect(ignoreExecute).toHaveBeenCalledExactlyOnceWith({
      playerId,
      outcomeId,
      encounterId,
      expectedEncounterRevision: 2n,
      idempotencyKey: "inbox:baileys:staging-immutable-choice",
    });
    fixture.issuedResolve.mockResolvedValue(
      ok({
        menuId: randomUUID(),
        playerId,
        outcomeId,
        encounterId,
        encounterRevision: 2n,
        ballItemIds: {},
        actionable: true,
        captureEnabled: false,
        battleEnabled: false,
        ignoreEnabled: false,
      }),
    );
    expect(await withIgnore.resolve(context("0"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(ignoreExecute).toHaveBeenCalledTimes(1);
  });

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

  it("starts canonical PvE only through an atomic Inbox and battle receipt", async () => {
    const execute = vi.fn(async () => ok({ battleId: randomUUID(), replayed: false }));
    const fixture = setup(execute);
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
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        playerId,
        outcomeId,
        encounterId,
        expectedEncounterRevision: 2n,
        idempotencyKey: "inbox:baileys:staging-immutable-choice",
        menuId: expect.any(String),
        inboxMessageId: expect.any(String),
        messageFingerprint: expect.any(String),
        senderRef,
      }),
    );
    expect(fixture.startCanonical).not.toHaveBeenCalled();
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
