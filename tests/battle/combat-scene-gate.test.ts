import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type CombatSceneBinding,
  CombatSceneGate,
  type CombatSceneReceipt,
  type CombatSceneRecord,
  type CombatSceneRepository,
  type CombatSceneTransaction,
  type PreparedSceneAction,
} from "../../src/modules/battle/combat-scene-gate.js";
import type {
  MessageHandlerContext,
  MessageHandlerResult,
} from "../../src/modules/messaging/contracts.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const prose = (n: number) => Array.from({ length: n }, () => "árvore").join(" ");
const player = "5511999990002@s.whatsapp.net",
  group = "120363777700000001@g.us";
function message(text: string, chat = group): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: randomUUID(),
    message: {
      provider: "baileys",
      externalMessageId: randomUUID(),
      senderRef: player,
      chatRef: chat,
      text,
      occurredAt: "2026-11-04T12:00:00Z",
      replyToExternalMessageId: null,
      mediaRefs: [],
    },
  };
}
class Memory implements CombatSceneRepository {
  records = new Map<string, CombatSceneRecord>();
  receipts = new Map<string, CombatSceneReceipt>();
  async serialized<T>(_p: string, _s: string, work: (tx: CombatSceneTransaction) => Promise<T>) {
    return work({
      load: async (scope) => this.records.get(scope) ?? null,
      save: async (scope, record) => {
        this.records.set(scope, structuredClone(record));
      },
      receipt: async (id) => this.receipts.get(id) ?? null,
      saveReceipt: async (id, receipt) => {
        this.receipts.set(id, structuredClone(receipt));
      },
    });
  }
}
function fixture() {
  const repository = new Memory();
  let version = 0;
  const binding: CombatSceneBinding = {
    subjectKind: "BATTLE",
    subjectId: randomUUID(),
    version: 0,
    actorKey: "PLAYER:synthetic:0",
    provider: "baileys",
    originChat: group,
    privateActionAllowed: true,
    deadline: "2026-11-05T00:00:00Z",
    knownArguments: { capturar: ["Poké Ball"] },
  };
  const result: MessageHandlerResult = {
    resultRefType: "BATTLE",
    resultRefId: binding.subjectId,
    outgoing: [],
  };
  const execute = vi.fn(async (_action: PreparedSceneAction) => ok(result));
  const recover = vi.fn(async () => ok(null as MessageHandlerResult | null));
  const bind = vi.fn(async () => ok({ ...binding, version }));
  const deps = { repository, bind, execute, recover, now: () => new Date("2026-11-04T12:00:00Z") };
  return {
    repository,
    execute,
    recover,
    bind,
    binding,
    result,
    gate: new CombatSceneGate(deps),
    restart: () => new CombatSceneGate(deps),
    nextTurn: () => {
      version++;
    },
  };
}
describe("persistent combat scene coordination contract", () => {
  it("rejects wrong chat and expired mandatory switch before effects", async () => {
    const f = fixture();
    expect(
      await f.gate.receive(message("/movimento 1 " + prose(50), "120363777700000099@g.us")),
    ).toMatchObject({ ok: false });
    f.bind.mockResolvedValue(
      ok({ ...f.binding, deadline: "2026-11-04T12:00:00Z", forcedSwitch: true }),
    );
    expect(await f.gate.receive(message("/trocar 2"))).toMatchObject({ ok: false });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.repository.records.size).toBe(0);
  });
  it("stages private action, rejects short Scene, accepts public Scene after restart", async () => {
    const f = fixture();
    const action = message("/movimento 2", player);
    const waiting = await f.gate.receive(action);
    expect(waiting.ok).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.restart().receive(message("/cena " + prose(49)))).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          {
            destinationRef: player,
            payload: { text: "Sua Cena tem 49/50 palavras; acrescente 1." },
          },
        ],
      },
    });
    expect(f.execute).not.toHaveBeenCalled();
    const scene = message("/cena " + prose(50));
    expect(await f.restart().receive(scene)).toEqual(ok(f.result));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0].context.idempotencyKey).toBe(action.idempotencyKey);
    expect(await f.restart().receive(scene)).toEqual(ok(f.result));
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("accepts scene first and combines it only with the same turn's action", async () => {
    const f = fixture();
    await f.gate.receive(message("/cena " + prose(50)));
    expect(f.execute).not.toHaveBeenCalled();
    await f.restart().receive(message("/trocar 2", player));
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.nextTurn();
    await f.gate.receive(message("/movimento 1", player));
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("accepts combined narrative with command at any position", async () => {
    for (const text of [
      `/movimento 1 ${prose(50)}`,
      `${prose(25)} /trocar 2 ${prose(25)}`,
      `${prose(50)} /fugir`,
    ]) {
      const f = fixture();
      await f.gate.receive(message(text));
      expect(f.execute).toHaveBeenCalledTimes(1);
    }
  });
  it("does not disclose private action contents in the group or acknowledge an invalid chat", async () => {
    const f = fixture();
    const response = await f.gate.receive(message("/movimento 2", player));
    expect(JSON.stringify(response)).not.toContain("/movimento 2");
    const wrong = await f.gate.receive(message("/cena " + prose(50), "120363888800000001@g.us"));
    expect(wrong.ok).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses forwarded text and changed message payload on replay", async () => {
    const f = fixture();
    const action = message("/movimento 1", player);
    await f.gate.receive(action);
    expect(
      (await f.gate.receive({ ...action, message: { ...action.message, text: "/trocar 2" } })).ok,
    ).toBe(false);
    const forwarded = message("/cena " + prose(50));
    expect(
      (await f.gate.receive({ ...forwarded, message: { ...forwarded.message, forwarded: true } }))
        .ok,
    ).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("recovers an effect committed before answer persistence without executing twice", async () => {
    const f = fixture();
    let committed = false;
    f.execute.mockImplementationOnce(async () => {
      committed = true;
      throw new Error("process interrupted after canonical commit");
    });
    const combined = message("/movimento 1 " + prose(50));
    await expect(f.gate.receive(combined)).rejects.toThrow("interrupted");
    f.recover.mockImplementation(async () => ok(committed ? f.result : null));
    expect(await f.restart().receive(combined)).toEqual(ok(f.result));
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("fails closed if a processing attempt is rebound to a later turn", async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce(err(appError("REVISION_CONFLICT", "changed")) as never);
    const combined = message("/movimento 1 " + prose(50));
    await f.gate.receive(combined);
    f.nextTurn();
    expect((await f.restart().receive(combined)).ok).toBe(false);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
