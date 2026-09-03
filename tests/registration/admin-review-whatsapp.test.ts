import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { RegistrationRevisionRecord } from "../../src/modules/registration/ports.js";
import { createRegistrationAdminWhatsAppRoutes } from "../../src/modules/registration/admin-review-whatsapp.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
const PLAYER_ID = "44444444-4444-4444-8444-444444444444" as never;
const ADMIN_ID = "55555555-5555-4555-8555-555555555555";
const REPLY_ID = "00000000000040008000000000000921";

function snapshot() {
  return {
    trainerName: "Liora Vale",
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId: "22222222-2222-4222-8222-222222222222",
    regionId: "11111111-1111-4111-8111-111111111111",
    schemaVersion: 1,
  } as const;
}

function review(revision = 4, status: RegistrationRevisionRecord["status"] = "SUBMITTED") {
  return {
    id: REVIEW_ID,
    playerId: PLAYER_ID,
    sequenceNo: 2,
    status,
    snapshot: snapshot(),
    revision,
  } satisfies RegistrationRevisionRecord;
}

function context(text: string, replyToExternalMessageId: string | null = REPLY_ID): MessageHandlerContext {
  return {
    inboxMessageId: "66666666-6666-4666-8666-666666666666",
    correlationId: "77777777-7777-4777-8777-777777777777",
    causationId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: `inbox:baileys:${text}`,
    message: {
      provider: "baileys",
      externalMessageId: `message:${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-03T06:50:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId,
    },
  };
}

function dependencies(current = review(), approveConflict = false) {
  const decisions: Array<{ kind: string; input: unknown }> = [];
  return {
    decisions,
    messageRefs: {
      findByProviderMessage: async (input: {
        readonly provider: string;
        readonly providerExternalMessageId: string;
      }) =>
        input.provider === "baileys" && input.providerExternalMessageId === REPLY_ID
          ? {
              provider: "baileys",
              providerExternalMessageId: REPLY_ID,
              outboxMessageId: "88888888-8888-4888-8888-888888888888",
              reviewId: REVIEW_ID,
              reviewRevision: 4,
            }
          : null,
    },
    admins: {
      resolvePrincipal: async () => ({ principalId: ADMIN_ID }),
    },
    registration: {
      getReview: async (reviewId: string) =>
        reviewId === REVIEW_ID ? ok(current) : err(appError("NOT_FOUND", "review not found")),
      requestChanges: async (input: unknown) => {
        decisions.push({ kind: "REQUEST_CHANGES", input });
        return ok({
          ...current,
          status: "CHANGES_REQUESTED" as const,
          revision: current.revision + 1,
          replayed: false,
        });
      },
      approve: async (input: unknown) => {
        decisions.push({ kind: "APPROVE", input });
        if (approveConflict) {
          return err(appError("REVISION_CONFLICT", "Registration review revision conflict"));
        }
        return ok({
          ...current,
          status: "APPROVED" as const,
          revision: current.revision + 1,
          replayed: false,
        });
      },
      reject: async (input: unknown) => {
        decisions.push({ kind: "REJECT", input });
        return ok({
          ...current,
          status: "REJECTED" as const,
          revision: current.revision + 1,
          replayed: false,
        });
      },
    },
  };
}

function route(command: string, deps = dependencies()) {
  const found = createRegistrationAdminWhatsAppRoutes(deps).find(
    (candidate) => candidate.command === command,
  );
  if (found === undefined) throw new Error(`Missing admin registration route ${command}`);
  return { found, deps };
}

describe("registration admin review over WhatsApp", () => {
  it("declares group + granular admin capability policy for every review command", () => {
    const routes = createRegistrationAdminWhatsAppRoutes(dependencies());
    expect(routes.find((candidate) => candidate.command === "verficha")?.policy).toEqual({
      requiredGroupCapabilities: ["admin.review"],
      requiredAdminCapability: "player.registration.read",
    });
    expect(routes.find((candidate) => candidate.command === "aprovar")?.policy).toEqual({
      requiredGroupCapabilities: ["admin.review"],
      requiredAdminCapability: "player.registration.approve",
    });
    expect(routes.find((candidate) => candidate.command === "ajustes")?.policy).toEqual({
      requiredGroupCapabilities: ["admin.review"],
      requiredAdminCapability: "player.registration.request_changes",
    });
    expect(routes.find((candidate) => candidate.command === "rejeitar")?.policy).toEqual({
      requiredGroupCapabilities: ["admin.review"],
      requiredAdminCapability: "player.registration.reject",
    });
  });

  it("shows the exact immutable ficha resolved from the replied provider message", async () => {
    const { found, deps } = route("verficha");
    const result = await found.handler.handle(context("$verficha"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_REVIEW",
        resultRefId: REVIEW_ID,
        outgoing: [
          {
            payload: {
              text: expect.stringMatching(/Liora Vale[\s\S]*17[\s\S]*Curiosa e competitiva/i),
            },
          },
        ],
      },
    });
    expect(deps.decisions).toEqual([]);
  });

  it("approves only the review revision anchored by the replied message", async () => {
    const { found, deps } = route("aprovar");
    const result = await found.handler.handle(context("$aprovar"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_REVIEW",
        resultRefId: REVIEW_ID,
        outgoing: [{ payload: { text: expect.stringMatching(/aprovada/i) } }],
      },
    });
    expect(deps.decisions).toEqual([
      {
        kind: "APPROVE",
        input: {
          reviewId: REVIEW_ID,
          expectedRevision: 4,
          actor: { adminPrincipalId: ADMIN_ID },
          idempotencyKey: "inbox:baileys:$aprovar:registration-review:approve",
        },
      },
    ]);
  });

  it("maps request-changes and reject without requiring an embedded manual comment", async () => {
    const adjust = route("ajustes");
    expect(await adjust.found.handler.handle(context("$ajustes"))).toMatchObject({ ok: true });
    expect(adjust.deps.decisions[0]).toEqual({
      kind: "REQUEST_CHANGES",
      input: {
        reviewId: REVIEW_ID,
        expectedRevision: 4,
        actor: { adminPrincipalId: ADMIN_ID },
        idempotencyKey: "inbox:baileys:$ajustes:registration-review:request_changes",
      },
    });

    const reject = route("rejeitar");
    expect(
      await reject.found.handler.handle(context("$rejeitar qualquer comentário livre")),
    ).toMatchObject({ ok: true });
    expect(reject.deps.decisions[0]).toEqual({
      kind: "REJECT",
      input: {
        reviewId: REVIEW_ID,
        expectedRevision: 4,
        actor: { adminPrincipalId: ADMIN_ID },
        idempotencyKey:
          "inbox:baileys:$rejeitar qualquer comentário livre:registration-review:reject",
      },
    });
  });

  it("fails closed when the admin command is not a reply to a persisted review notification", async () => {
    const { found, deps } = route("aprovar");
    expect(await found.handler.handle(context("$aprovar", null))).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    expect(deps.decisions).toEqual([]);
  });

  it("propagates an explicit revision conflict from an obsolete reply anchor", async () => {
    const deps = dependencies(review(5), true);
    const { found } = route("aprovar", deps);

    expect(await found.handler.handle(context("$aprovar"))).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(deps.decisions).toHaveLength(1);
  });
});
