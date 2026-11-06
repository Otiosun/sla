import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import { CommunityService } from "../../src/modules/community/service.js";
import {
  expeditionOperationAllowed,
  withExpeditionAudience,
} from "../../src/modules/exploration/expedition-runtime-audience.js";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PostgresOperationalUxReadModel } from "../../src/platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerAccessRepository } from "../../src/platform/registration/postgres-player-access-repository.js";
import { createOperationalSimulatedWhatsAppRuntime } from "../../src/runtime/compose-simulated-whatsapp-runtime.js";
import {
  createOperationalExpeditionDelivery,
  createOperationalMessagingComposition,
} from "../../src/runtime/compose-whatsapp-runtime.js";
import { OperationalExpeditionLegacyBoundary } from "../../src/runtime/operational-expedition-legacy-boundary.js";
import { loadOperationalExpeditionPreview } from "../../src/runtime/operational-expedition-preview.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const input: IncomingMessage = {
  provider: "baileys",
  externalMessageId: "exploration-optin-1",
  senderRef: "5579999999999@s.whatsapp.net",
  chatRef: "120363123456789@g.us",
  occurredAt: "2026-11-01T12:00:00.000Z",
  text: "/explorar status",
  replyToExternalMessageId: null,
  mediaRefs: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Exploration V4 status is NOT a default runtime route", () => {
  it("cannot enable complete offline choices with live WhatsApp, even with staging keys", () => {
    const inputPool = {} as Pool;
    const key = Buffer.alloc(32, 0x27);
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    expect(() =>
      createOperationalMessagingComposition(
        inputPool,
        { encryptionKey: key, encryptionKeyVersion: 1 },
        null,
        { turnWindowTtlMs: 30000, maintenanceBatchSize: 1, encryptionKeys: new Map([[1, key]]) },
        null,
        null,
        "Etc/UTC",
        true,
        key,
        true,
      ),
    ).toThrow("isolated non-Baileys test mode");
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    expect(() =>
      createOperationalMessagingComposition(
        inputPool,
        null,
        null,
        null,
        null,
        null,
        null,
        false,
        null,
        true,
      ),
    ).toThrow("isolated non-Baileys test mode");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    expect(() =>
      createOperationalMessagingComposition(
        inputPool,
        null,
        null,
        null,
        null,
        null,
        null,
        false,
        null,
        true,
      ),
    ).toThrow("complete staging exploration and PvE dependencies");
  });
  it("composes real private numeric-choice routing only with the complete offline feature set", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    const key = Buffer.alloc(32, 0x29);
    const composition = createOperationalMessagingComposition(
      {} as Pool,
      { encryptionKey: key, encryptionKeyVersion: 1 },
      null,
      { turnWindowTtlMs: 30000, maintenanceBatchSize: 1, encryptionKeys: new Map([[1, key]]) },
      null,
      null,
      "Etc/UTC",
      true,
      Buffer.alloc(32, 0x37),
      true,
    );
    const reply = {
      ...input,
      chatRef: input.senderRef,
      text: "1",
      replyToExternalMessageId: "A".repeat(32),
    };
    expect(await composition.admitFreeform(reply)).toBe(true);
    expect(await composition.admitFreeform({ ...reply, text: "0" })).toBe(true);
    expect(await composition.admitFreeform({ ...reply, text: "4" })).toBe(true);
  });

  it("assembles all V4 post-SENT, menu and choice services only in the isolated simulator", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    const secret = Buffer.alloc(32, 0x54);
    const simulated = createOperationalSimulatedWhatsAppRuntime({
      pool: {} as Pool,
      explorationPreviewTimeZone: "Etc/UTC",
      explorationStagingPreparationEnabled: true,
      explorationStagingSearchSecret: Buffer.alloc(32, 0x35),
      explorationOfflineChoicesEnabled: true,
      encounterRngConfig: {
        encryptionKey: secret,
        encryptionKeyVersion: 1,
      },
      pveBattleConfig: {
        turnWindowTtlMs: 30_000,
        maintenanceBatchSize: 5,
        encryptionKeys: new Map([[1, secret]]),
      },
    });
    const quoted = {
      ...input,
      chatRef: input.senderRef,
      text: "1",
      replyToExternalMessageId: "A".repeat(32),
    };
    expect(await simulated.composition.admitFreeform(quoted)).toBe(true);
    expect(simulated.expeditionPostSentFailures).toEqual([]);
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    expect(() =>
      createOperationalSimulatedWhatsAppRuntime({
        pool: {} as Pool,
        explorationOfflineChoicesEnabled: true,
      }),
    ).toThrow("isolated non-Baileys test mode");
  });

  it("keeps exploration command unknown with the exact production positional defaults", () => {
    const composition = createOperationalMessagingComposition({} as Pool);
    expect(composition.admitCommand(input)).toBe(false);
  });

  it("registers only the read-only status command with an explicit staging calendar", () => {
    const composition = createOperationalMessagingComposition(
      {} as Pool,
      null,
      null,
      null,
      null,
      null,
      "Etc/UTC",
    );
    expect(composition.admitCommand(input)).toBe(true);
    expect(composition.router.classify(input).command).toBe("explorar");
  });

  it("rejects an invalid staging calendar before SQL or messaging", () => {
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        null,
        null,
        null,
        null,
        null,
        "Mars/Zhoulia",
      ),
    ).toThrow();
  });
  it("requires BOTH staging flags before preparation can be composed", () => {
    expect(() =>
      createOperationalMessagingComposition({} as Pool, null, null, null, null, null, null, true),
    ).toThrow("requires a separate explicit expedition calendar");

    const prepared = createOperationalMessagingComposition(
      {} as Pool,
      null,
      null,
      null,
      null,
      null,
      "Etc/UTC",
      true,
    );
    expect(prepared.admitCommand(input)).toBe(true);

    const defaultNoWrite = createOperationalMessagingComposition(
      {} as Pool,
      null,
      null,
      null,
      null,
      null,
      "Etc/UTC",
      false,
    );
    expect(defaultNoWrite.admitCommand(input)).toBe(true);
  });
  it("does not enable search without a third opt-in and encounter RNG", () => {
    const key = Buffer.alloc(32, 0x25);
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        null,
        null,
        null,
        null,
        null,
        "Etc/UTC",
        true,
        key,
      ),
    ).toThrow("requires explicit preparation");
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
        null,
        null,
        null,
        null,
        "Etc/UTC",
        false,
        key,
      ),
    ).toThrow("requires explicit preparation");
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
        null,
        null,
        null,
        null,
        null,
        true,
        key,
      ),
    ).toThrow("requires a separate explicit expedition calendar");
  });

  it("requires a real staging HMAC key even with all three explicit flags", () => {
    expect(() =>
      createOperationalMessagingComposition(
        {} as Pool,
        { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
        null,
        null,
        null,
        null,
        "Etc/UTC",
        true,
        Buffer.alloc(12),
      ),
    ).toThrow("missing or too short");

    const candidate = createOperationalMessagingComposition(
      {} as Pool,
      { encryptionKey: Buffer.alloc(32, 0x33), encryptionKeyVersion: 1 },
      null,
      null,
      null,
      null,
      "Etc/UTC",
      true,
      Buffer.alloc(32, 0x27),
    );
    expect(candidate.admitCommand({ ...input, text: "/explorar buscar" })).toBe(true);
    expect(
      createOperationalMessagingComposition({} as Pool).admitCommand({
        ...input,
        text: "/explorar buscar",
      }),
    ).toBe(false);
  });
});

describe("private operational read-only V4 admission", () => {
  it("is off by default and refuses opt-in without explicit account IDs", () => {
    expect(loadOperationalExpeditionPreview({})).toBeNull();
    expect(loadOperationalExpeditionPreview({ EXPEDITION_V4_PRIVATE_PREVIEW: "false" })).toBeNull();
    expect(() =>
      loadOperationalExpeditionPreview({ EXPEDITION_V4_PRIVATE_PREVIEW: "true" }),
    ).toThrow("explicit player IDs");
  });

  it("admits only the resolved account and preserves legacy commands for ordinary players", async () => {
    const allowed = createPlayerId();
    const ordinary = createPlayerId();
    vi.spyOn(PlayerRegistrationService.prototype, "resolvePlayer").mockImplementation(
      async (identity) =>
        ok({
          playerId:
            (identity as { externalId: string }).externalId === input.senderRef
              ? allowed
              : ordinary,
          state: "COMPLETE",
          created: false,
        }),
    );
    vi.spyOn(CommunityService.prototype, "resolveChat").mockResolvedValue({
      known: false,
      groupId: null,
      role: null,
      capabilities: [],
    });
    const config = loadOperationalExpeditionPreview({
      EXPEDITION_V4_PRIVATE_PREVIEW: "true",
      EXPEDITION_V4_ALLOWED_PLAYER_IDS: allowed,
    });
    const composition = createOperationalMessagingComposition(
      {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        connect: vi
          .fn()
          .mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
      } as unknown as Pool,
      null,
      null,
      null,
      null,
      null,
      "America/Sao_Paulo",
      false,
      null,
      false,
      false,
      false,
      false,
      0,
      config,
    );
    const other = { ...input, senderRef: "5579999999998@s.whatsapp.net" };
    expect(await composition.admitRuntimeCommand(input)).toBe(true);
    expect(await composition.admitRuntimeCommand(other)).toBe(false);
    expect(await composition.admitRuntimeCommand({ ...input, provider: "synthetic" })).toBe(false);
    const context = {
      inboxMessageId: "inbox",
      correlationId: "correlation",
      causationId: "cause",
      idempotencyKey: "key",
      message: other,
    };
    expect(await composition.router.dispatch(context)).toEqual(ok(null));
    vi.spyOn(RuntimeCommandPolicyGate.prototype, "authorize").mockResolvedValue(ok(undefined));
    const write = await composition.router.dispatch({
      ...context,
      message: { ...input, text: "/explorar buscar" },
    });
    expect(write.ok).toBe(true);
    expect(JSON.stringify(write)).toContain("Nenhuma ação será executada");
    vi.spyOn(PostgresOperationalUxReadModel.prototype, "activeBattleId").mockResolvedValue(
      "legacy-battle",
    );
    const menu = { ...other, text: "/menu" };
    expect(await composition.admitRuntimeCommand(menu)).toBe(true);
    const menuResult = await composition.router.dispatch({ ...context, message: menu });
    expect(menuResult.ok).toBe(true);
    expect(JSON.stringify(menuResult)).toContain("/batalha");
    expect(JSON.stringify(menuResult)).not.toMatch(/explorar/i);
  });
});

describe("operational V4 write and replay audience", () => {
  it("isolates concurrent authorization and overrides the simulator bypass on denial", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WHATSAPP_ENABLED", "false");
    const owner = createPlayerId();
    const other = createPlayerId();
    const [authorized, denied] = await Promise.all([
      withExpeditionAudience(owner, async () => {
        await Promise.resolve();
        return [expeditionOperationAllowed(owner), expeditionOperationAllowed(other)];
      }),
      withExpeditionAudience(null, async () => {
        await Promise.resolve();
        return expeditionOperationAllowed(owner);
      }),
    ]);
    expect(authorized).toEqual([true, false]);
    expect(denied).toBe(false);
  });

  it("blocks direct, old-quote and background V4 writes after account removal while leaving legacy commands admitted", async () => {
    const owner = createPlayerId();
    const removed = createPlayerId();
    const key = Buffer.alloc(32, 0x25);
    const play = loadOperationalExpeditionPreview({
      EXPEDITION_V4_PRIVATE_PLAY: "true",
      EXPEDITION_V4_ALLOWED_PLAYER_IDS: owner,
      EXPEDITION_V4_PLAY_SECRET_BASE64: key.toString("base64"),
    });
    vi.spyOn(PlayerRegistrationService.prototype, "resolvePlayer").mockImplementation(
      async (identity) =>
        ok({
          playerId:
            (identity as { externalId: string }).externalId === input.senderRef ? owner : removed,
          state: "COMPLETE",
          created: false,
        }),
    );
    vi.spyOn(PostgresPlayerAccessRepository.prototype, "read").mockImplementation(async (work) =>
      work({ load: async () => ({ status: "ACTIVE" }) } as never),
    );
    vi.spyOn(CommunityService.prototype, "resolveChat").mockResolvedValue({
      known: false,
      groupId: null,
      role: null,
      capabilities: [],
    });
    vi.spyOn(OperationalExpeditionLegacyBoundary.prototype, "hasOpenV4Subject").mockImplementation(
      async (id) => id === removed,
    );
    const composition = createOperationalMessagingComposition(
      { options: { max: 2 } } as Pool,
      { encryptionKey: key, encryptionKeyVersion: 1 },
      null,
      { turnWindowTtlMs: 30_000, maintenanceBatchSize: 1, encryptionKeys: new Map([[1, key]]) },
      null,
      null,
      "America/Sao_Paulo",
      false,
      null,
      false,
      false,
      false,
      false,
      0,
      play,
    );
    const other = { ...input, senderRef: "5579999999998@s.whatsapp.net" };
    const context = {
      inboxMessageId: "inbox",
      correlationId: "correlation",
      causationId: "cause",
      idempotencyKey: "key",
      message: other,
    };
    expect(await composition.admitRuntimeCommand({ ...input, text: "/explorar buscar" })).toBe(
      true,
    );
    expect(await composition.admitRuntimeCommand({ ...other, text: "/explorar buscar" })).toBe(
      false,
    );
    expect(
      await composition.router.dispatch({
        ...context,
        message: { ...other, text: "/explorar buscar" },
      }),
    ).toEqual(ok(null));
    expect(
      await composition.router.dispatch({ ...context, message: { ...other, text: "/capturar" } }),
    ).toEqual(ok(null));
    expect(
      await composition.router.dispatch({
        ...context,
        message: { ...other, text: "2", replyToExternalMessageId: "old" },
      }),
    ).toEqual(ok(null));
    expect(await composition.admitRuntimeCommand({ ...other, text: "/menu" })).toBe(true);
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ available: true }] })
        .mockResolvedValueOnce({ rows: [{ player_id: removed, active: true }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Pool;
    const boundary = new OperationalExpeditionLegacyBoundary(pool, new Set([owner]));
    expect(await boundary.permitsBattle("removed-v4-battle")).toBe(false);
    expect(await boundary.permitsBattle("legacy-battle")).toBe(true);
  });
  it("allows legacy delivery while rejecting queued V4 menus when the player is removed or the flag is off", async () => {
    const owner = createPlayerId();
    const other = createPlayerId();
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as unknown as Pool;
    const navigation = (playerId: string) => ({
      destinationRef: input.senderRef,
      payload: { expeditionNavigation: { playerId } },
    });
    const off = createOperationalExpeditionDelivery({ pool }, vi.fn());
    expect(await off.permitsDelivery(navigation(owner))).toBe(false);
    expect(
      await off.permitsDelivery({ destinationRef: input.senderRef, payload: { text: "legacy" } }),
    ).toBe(true);
    expect(query).not.toHaveBeenCalled();
    const enabled = createOperationalExpeditionDelivery(
      {
        pool,
        expeditionPreview: {
          allowedPlayerIds: new Set([owner]),
          timeZone: "America/Sao_Paulo",
          playSecret: Buffer.alloc(32),
        },
      },
      vi.fn(),
    );
    expect(await enabled.permitsDelivery(navigation(other))).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(await enabled.permitsDelivery(navigation(owner))).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("a.status='ACTIVE'"), [
      owner,
      input.senderRef,
    ]);
  });
});
