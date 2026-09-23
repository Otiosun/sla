import { describe, expect, it, vi } from "vitest";
import {
  createUatBootstrapRoutes,
  type UatBootstrapRouteService,
} from "../../src/modules/admin/uat-bootstrap.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { ok } from "../../src/shared-kernel/result.js";

const SELF = "5511000000001@s.whatsapp.net";
const A = "5511000000002@s.whatsapp.net";
const B = "5511000000003@s.whatsapp.net";

function context(text: string, mentions: readonly string[] = []): MessageHandlerContext {
  return {
    inboxMessageId: "inbox-1",
    correlationId: "11111111-1111-4111-8111-111111111111",
    causationId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: `test:${text}`,
    message: {
      provider: "baileys",
      externalMessageId: `wamid:${text}`,
      senderRef: SELF,
      chatRef: "120363000000000000@g.us",
      occurredAt: "2026-09-11T22:00:00.000Z",
      text,
      mediaRefs: [],
      mentions: [...mentions],
      replyToExternalMessageId: null,
    },
  };
}

function setup() {
  const service: UatBootstrapRouteService = {
    status: vi.fn(async ({ externalId }) => ok(`STATUS:${externalId}`)),
    bootstrap: vi.fn(async ({ externalId }) =>
      ok({
        playerId: `player:${externalId}`,
        access: "ACTIVE",
        area: "Vila dos Arrozais",
        party: null,
        uat: true,
        roster: true,
      }),
    ),
    prepare: vi.fn(async (a, b) =>
      ok([
        {
          playerId: `player:${a.externalId}`,
          access: "ACTIVE",
          area: "Vila dos Arrozais",
          party: null,
          uat: true,
          roster: true,
        },
        {
          playerId: `player:${b.externalId}`,
          access: "ACTIVE",
          area: "Vila dos Arrozais",
          party: null,
          uat: true,
          roster: true,
        },
      ]),
    ),
  };

  const routes = createUatBootstrapRoutes({
    admins: {
      resolvePrincipal: vi.fn(async () => ({ principalId: "admin-1" })),
    },
    service,
  });

  const route = (command: "teste" | "adm") => {
    const found = routes.find((candidate) => candidate.command === command);
    if (found === undefined) throw new Error(`route ${command} missing`);
    return found;
  };

  return { service, route };
}

describe("human UAT WhatsApp commands", () => {
  it("/teste shows human help without mutating anyone", async () => {
    const { service, route } = setup();
    const result = await route("teste").handler.handle(context("/teste"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outgoing[0]?.payload.text).toContain("/teste eu");
    expect(result.value.resultRefId).toBeNull();
    expect(result.value.outgoing[0]?.payload.text).toContain("/teste preparar");
    expect(service.status).not.toHaveBeenCalled();
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("/teste eu diagnoses the sender without requiring self-mention", async () => {
    const { service, route } = setup();
    const result = await route("teste").handler.handle(context("/teste eu"));

    expect(result.ok).toBe(true);
    expect(service.status).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: SELF,
    });
  });

  it("/teste @alvo diagnoses one mentioned player", async () => {
    const { service, route } = setup();
    const result = await route("teste").handler.handle(context("/teste @A", [A]));

    expect(result.ok).toBe(true);
    expect(service.status).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: A,
    });
  });

  it("/teste preparar prepares the sender without a mention", async () => {
    const { service, route } = setup();
    const result = await route("teste").handler.handle(context("/teste preparar"));

    expect(result.ok).toBe(true);
    expect(service.bootstrap).toHaveBeenCalledWith(
      { provider: "baileys", externalId: SELF },
      "admin-1",
    );
  });

  it("/teste preparar @alvo prepares one target", async () => {
    const { service, route } = setup();
    const result = await route("teste").handler.handle(context("/teste preparar @A", [A]));

    expect(result.ok).toBe(true);
    expect(service.bootstrap).toHaveBeenCalledWith(
      { provider: "baileys", externalId: A },
      "admin-1",
    );
  });

  it("/teste preparar @A @B prepares a compatible pair", async () => {
    const { service, route } = setup();
    const result = await route("teste").handler.handle(context("/teste preparar @A @B", [A, B]));

    expect(result.ok).toBe(true);
    expect(service.prepare).toHaveBeenCalledWith(
      { provider: "baileys", externalId: A },
      { provider: "baileys", externalId: B },
      "admin-1",
    );
  });

  it("keeps /adm teste criar as a legacy alias", async () => {
    const { service, route } = setup();
    const result = await route("adm").handler.handle(context("/adm teste criar @A", [A]));

    expect(result.ok).toBe(true);
    expect(service.bootstrap).toHaveBeenCalledWith(
      { provider: "baileys", externalId: A },
      "admin-1",
    );
  });
});
