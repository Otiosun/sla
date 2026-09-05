import { describe, expect, it } from "vitest";
import type { CommandPolicyRequirement } from "../../src/modules/community/command-policy.js";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  type IncomingMessage,
  type MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import {
  type CommandRouteDefinition,
  type CommandRoutePolicyGate,
  MessageRouter,
} from "../../src/modules/messaging/router.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

function incoming(text: string): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "baileys",
    externalMessageId: `msg-${text}`,
    senderRef: "sender-1",
    chatRef: "chat-1",
    occurredAt: "2026-09-01T20:00:00-03:00",
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  });
}

function context(message: IncomingMessage): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000000001",
    correlationId: "00000000-0000-4000-8000-000000000002",
    causationId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: incomingMessageIdempotencyKey(message),
    message,
  };
}

const worldPolicy: CommandPolicyRequirement = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
};

function protectedRoute(onHandle: () => void): CommandRouteDefinition {
  return {
    command: "ir",
    policy: worldPolicy,
    handler: {
      async handle() {
        onHandle();
        return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
      },
    },
  };
}

describe("MessageRouter command policy gate", () => {
  it("fails closed when a protected route is registered without a policy gate", async () => {
    let handlerCalls = 0;
    const router = new MessageRouter([
      protectedRoute(() => {
        handlerCalls += 1;
      }),
    ]);

    const result = await router.dispatch(context(incoming("$ir rota-1 v1")));

    expect(result).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(handlerCalls).toBe(0);
  });

  it("does not invoke the handler when the policy gate denies", async () => {
    let handlerCalls = 0;
    const gate: CommandRoutePolicyGate = {
      authorize: async () => err(appError("PLAYER_INELIGIBLE", "blocked by test policy")),
    };
    const router = new MessageRouter(
      [
        protectedRoute(() => {
          handlerCalls += 1;
        }),
      ],
      gate,
    );

    const result = await router.dispatch(context(incoming("$ir rota-1 v1")));

    expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    expect(handlerCalls).toBe(0);
  });

  it("passes the exact route policy and message context to the gate before dispatch", async () => {
    let observedPolicy: CommandPolicyRequirement | null = null;
    let observedChatRef: string | null = null;
    let handlerCalls = 0;
    const gate: CommandRoutePolicyGate = {
      authorize: async (handlerContext, policy) => {
        observedPolicy = policy;
        observedChatRef = handlerContext.message.chatRef;
        return ok(undefined);
      },
    };
    const router = new MessageRouter(
      [
        protectedRoute(() => {
          handlerCalls += 1;
        }),
      ],
      gate,
    );

    const result = await router.dispatch(context(incoming("$ir rota-1 v1")));

    expect(result.ok).toBe(true);
    expect(observedPolicy).toEqual(worldPolicy);
    expect(observedChatRef).toBe("chat-1");
    expect(handlerCalls).toBe(1);
  });

  it("keeps unprotected routes backward compatible without a policy gate", async () => {
    let handlerCalls = 0;
    const router = new MessageRouter([
      {
        command: "menu",
        handler: {
          async handle() {
            handlerCalls += 1;
            return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
          },
        },
      },
    ]);

    expect((await router.dispatch(context(incoming("$menu")))).ok).toBe(true);
    expect(handlerCalls).toBe(1);
  });
});
