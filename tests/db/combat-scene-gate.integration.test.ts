import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CombatSceneBinding,
  CombatSceneGate,
} from "../../src/modules/battle/combat-scene-gate.js";
import type {
  MessageHandlerContext,
  MessageHandlerResult,
} from "../../src/modules/messaging/contracts.js";
import { PostgresCombatSceneRepository } from "../../src/platform/battle/postgres-combat-scene-repository.js";
import { ok } from "../../src/shared-kernel/result.js";

const source = new URL(process.env.DATABASE_URL ?? "");
if (
  source.hostname !== "127.0.0.1" ||
  process.env.APP_ENV !== "test" ||
  process.env.WHATSAPP_ENABLED !== "false" ||
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1"
)
  throw Error("Disposable PostgreSQL required");
const db = "combat_scene_" + randomUUID().replaceAll("-", "");
const group = "120363777700000001@g.us",
  sender = "5511999990002@s.whatsapp.net";
const scene = Array.from({ length: 50 }, () => "árvore").join(" ");
function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: randomUUID(),
    message: {
      provider: "baileys",
      externalMessageId: randomUUID(),
      senderRef: sender,
      chatRef: group,
      text,
      occurredAt: new Date().toISOString(),
      replyToExternalMessageId: null,
      mediaRefs: [],
    },
  };
}
describe.sequential("combat Scene durable execution claims on disposable PostgreSQL", () => {
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: source.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${db}"`);
    const url = new URL(source);
    url.pathname = "/" + db;
    pool = new Pool({ connectionString: url.toString(), max: 6 });
    await pool.query(
      await readFile(
        new URL("../../db/candidates/0081_combat_scene_gate.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query("CREATE TABLE scene_test_effects(key TEXT PRIMARY KEY)");
  }, 60000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
      await admin.end();
    }
  }, 60000);
  function fixture(crash = false) {
    const binding: CombatSceneBinding = {
      provider: "baileys",
      subjectKind: "BATTLE",
      subjectId: randomUUID(),
      version: 0,
      actorKey: randomUUID(),
      originChat: group,
      privateActionAllowed: true,
      deadline: null,
      knownArguments: {},
    };
    const result: MessageHandlerResult = {
      resultRefType: "BATTLE",
      resultRefId: binding.subjectId,
      outgoing: [],
    };
    let calls = 0;
    const make = () =>
      new CombatSceneGate({
        repository: new PostgresCombatSceneRepository(pool),
        now: () => new Date(),
        bind: async () => ok(binding),
        execute: async (action) => {
          calls++;
          await pool.query(
            "INSERT INTO scene_test_effects(key) VALUES($1) ON CONFLICT DO NOTHING",
            [action.context.idempotencyKey],
          );
          if (crash) {
            crash = false;
            throw Error("crash after canonical commit");
          }
          return ok(result);
        },
        recover: async (record) => {
          const effect = await pool.query("SELECT 1 FROM scene_test_effects WHERE key=$1", [
            record.action?.context.idempotencyKey,
          ]);
          return ok(effect.rowCount ? result : null);
        },
      });
    return { make, binding, result, calls: () => calls };
  }
  it("serializes simultaneous duplicate delivery to one resource effect", async () => {
    const f = fixture(),
      input = context("/movimento 1 " + scene);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.make().receive(input)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(f.calls()).toBe(1);
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM scene_test_effects WHERE key=$1", [
          input.idempotencyKey,
        ])
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
  it("persists private action without an effect and accepts a later Scene after restart", async () => {
    const f = fixture(),
      action = context("/trocar 2");
    await f.make().receive({ ...action, message: { ...action.message, chatRef: sender } });
    expect(f.calls()).toBe(0);
    await f.make().receive(context("/cena " + scene));
    expect(f.calls()).toBe(1);
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM scene_test_effects WHERE key=$1", [
          action.idempotencyKey,
        ])
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
  it("recovers the commit/answer failure window without a second effect", async () => {
    const f = fixture(true),
      input = context("/movimento 1 " + scene);
    await expect(f.make().receive(input)).rejects.toThrow("canonical commit");
    expect(await f.make().receive(input)).toEqual(ok(f.result));
    expect(f.calls()).toBe(1);
  });
  it("refuses changed payload under the same message identity", async () => {
    const f = fixture(),
      input = context("/movimento 1");
    await f.make().receive(input);
    expect(
      (await f.make().receive({ ...input, message: { ...input.message, text: "/trocar 2" } })).ok,
    ).toBe(false);
    expect(f.calls()).toBe(0);
  });
});
