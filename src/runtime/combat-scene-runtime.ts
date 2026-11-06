import type { Pool } from "pg";
import { CombatSceneGate } from "../modules/battle/combat-scene-gate.js";
import type { PveSceneDependencies } from "../modules/battle/pve-scene-whatsapp.js";
import { parseSceneAction } from "../modules/battle/scene-action.js";
import type {
  MessageHandlerContext,
  MessageHandlerResult,
} from "../modules/messaging/contracts.js";
import type { CommandRouteDefinition } from "../modules/messaging/router.js";
import { PostgresCombatSceneContext } from "../platform/battle/postgres-combat-scene-context.js";
import { PostgresCombatSceneRepository } from "../platform/battle/postgres-combat-scene-repository.js";
import { appError, err, type Result } from "../shared-kernel/result.js";

export function createCombatSceneRuntime(
  pool: Pool,
  deps: Pick<
    PveSceneDependencies,
    | "players"
    | "admins"
    | "captureBalls"
    | "presentation"
    | "competitiveCapture"
    | "controllers"
    | "roster"
  >,
  rawRoutes: readonly CommandRouteDefinition[],
  expedition: (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult | null>>,
) {
  const reader = new PostgresCombatSceneContext(pool, deps);
  const raw = new Map(rawRoutes.map((route) => [route.command, route]));
  const gate = new CombatSceneGate({
    repository: new PostgresCombatSceneRepository(pool),
    now: () => new Date(),
    bind: reader.bind.bind(reader),
    recover: reader.recover.bind(reader),
    execute: async (action, binding) => {
      if (action.route === "EXPEDITION") {
        const result = await expedition(action.context);
        return result.ok && result.value === null
          ? err(appError("FLOW_BLOCKED", "A seleção de captura não está mais disponível."))
          : (result as Result<MessageHandlerResult>);
      }
      const name = action.context.message.text?.match(/^\/(\p{L}+)/u)?.[1];
      const handler = name ? raw.get(name)?.handler : undefined;
      if (!handler) return err(appError("ACTION_INVALID", "Ação de Cena sem executor canônico."));
      const result = await handler.handle({ ...action.context, combatSceneAuthorization: binding });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          ...result.value,
          outgoing: result.value.outgoing.map((outgoing) =>
            outgoing.payload.combatResolution === true
              ? { ...outgoing, destinationRef: binding.originChat }
              : outgoing,
          ),
        },
      };
    },
  });
  const wrapped = rawRoutes.map((route) => {
    if (!["movimento", "trocar", "capturar", "fugir"].includes(route.command)) return route;
    const {
      requiredGroupCapabilities: _group,
      requiredAnyGroupCapabilities: _any,
      ...basePolicy
    } = route.policy ?? {};
    return {
      ...route,
      policy: { ...basePolicy, allowedPlayerAccess: ["ACTIVE"] as const },
      policyForContext: (context: MessageHandlerContext) =>
        context.message.chatRef === context.message.senderRef ? undefined : route.policy,
      handler: {
        handle: async (context: MessageHandlerContext) => {
          const result = await gate.receive(context);
          // Competitive identification is separate from a canonical battle/encounter.
          if (
            !result.ok &&
            result.error.code === "NOT_FOUND" &&
            route.command === "capturar" &&
            deps.competitiveCapture
          ) {
            const competitive = await deps.competitiveCapture.resolveGuessCommand(context);
            return competitive.ok && competitive.value === null
              ? result
              : (competitive as Result<MessageHandlerResult>);
          }
          return result;
        },
      },
    };
  });
  const sceneRoute: CommandRouteDefinition = {
    command: "cena",
    commandAnnotation: true,
    allowEmbedded: true,
    policy: {
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
      mechanicalReadyAdminBypassCapability: "encounter.support",
    },
    handler: { handle: (context) => gate.receive(context) },
  };
  return {
    gate,
    routes: [...wrapped, sceneRoute],
    resolve: async (context: MessageHandlerContext) => {
      const parsed = parseSceneAction(context.message.text);
      if (parsed.kind === "NONE") return { ok: true as const, value: null };
      if (parsed.kind === "ACTION" && parsed.intent.type === "SURRENDER")
        return raw.get("desistir")!.handler.handle(context);
      return gate.receive(context);
    },
  };
}
