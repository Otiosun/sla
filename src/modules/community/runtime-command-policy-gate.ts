import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext } from "../messaging/contracts.js";
import type { CommandRoutePolicyGate } from "../messaging/router.js";
import type { PlayerAccessRecord } from "../registration/player-access-ports.js";
import type { CommandPolicyRequirement } from "./command-policy.js";
import type { CommunityChatContext } from "./contracts.js";

interface CommunityContextResolver {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<CommunityChatContext>;
}

interface PlayerIdentityResolver {
  resolvePlayer(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<Result<{ readonly playerId: PlayerId; readonly state: string }>>;
}

interface PlayerAccessReader {
  load(playerId: PlayerId): Promise<PlayerAccessRecord>;
}

interface AdminCapabilityResolver {
  capabilitiesFor(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<readonly string[]>;
}

export interface RuntimeCommandPolicyGateDependencies {
  readonly community: CommunityContextResolver;
  readonly players: PlayerIdentityResolver;
  readonly access: PlayerAccessReader;
  readonly admins: AdminCapabilityResolver;
}

export class RuntimeCommandPolicyGate implements CommandRoutePolicyGate {
  public constructor(private readonly dependencies: RuntimeCommandPolicyGateDependencies) {}

  public async authorize(
    context: MessageHandlerContext,
    requirement: CommandPolicyRequirement,
  ): Promise<Result<void>> {
    const requiresGroupContext =
      (requirement.requiredGroupCapabilities?.length ?? 0) > 0 ||
      (requirement.requiredAnyGroupCapabilities?.length ?? 0) > 0;

    if (requiresGroupContext) {
      const group = await this.dependencies.community.resolveChat({
        provider: context.message.provider,
        chatRef: context.message.chatRef,
      });
      if (!group.known) {
        return err(
          appError("FLOW_BLOCKED", "This command requires a configured RPG group", {
            userMessage:
              "Este grupo ainda não está habilitado para esse comando. Um administrador precisa configurá-lo com `/grupo recepcao Nome` ou `/grupo jogo Nome`.",
          }),
        );
      }

      for (const capability of requirement.requiredGroupCapabilities ?? []) {
        if (!group.capabilities.includes(capability)) {
          return err(
            appError("FLOW_BLOCKED", "This command is not enabled in this group", {
              userMessage: "Este comando não está habilitado neste tipo de grupo.",
            }),
          );
        }
      }

      if (
        requirement.requiredAnyGroupCapabilities !== undefined &&
        !requirement.requiredAnyGroupCapabilities.some((capability) =>
          group.capabilities.includes(capability),
        )
      ) {
        return err(
          appError("FLOW_BLOCKED", "This command is not enabled in this group", {
            userMessage: "Este comando não está habilitado neste tipo de grupo.",
          }),
        );
      }
    }

    if (requirement.requiredAdminCapability !== undefined) {
      const adminCapabilities = await this.dependencies.admins.capabilitiesFor({
        provider: context.message.provider,
        externalId: context.message.senderRef,
      });
      if (!adminCapabilities.includes(requirement.requiredAdminCapability)) {
        return err(
          appError("PLAYER_INELIGIBLE", "Administrative capability is required", {
            userMessage: "Este comando exige uma permissão administrativa do RPG.",
          }),
        );
      }
    }

    const needsPlayer =
      requirement.allowedPlayerAccess !== undefined || requirement.requiresMechanicalReady === true;
    if (!needsPlayer) return ok(undefined);

    const player = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!player.ok) {
      if (player.error.code !== "NOT_FOUND") return err(player.error);
      if (
        requirement.allowedPlayerAccess !== undefined &&
        !requirement.allowedPlayerAccess.includes("PENDING")
      ) {
        return err(
          appError("PLAYER_INELIGIBLE", "Player access state does not allow this command", {
            userMessage: "Seu cadastro ainda não permite usar este comando.",
          }),
        );
      }
      if (requirement.requiresMechanicalReady === true) {
        return err(
          appError("FLOW_BLOCKED", "Player mechanical state is not ready for this command", {
            userMessage:
              "Conclua o cadastro e a preparação do treinador antes de usar este comando.",
          }),
        );
      }
      return ok(undefined);
    }

    const access = await this.dependencies.access.load(player.value.playerId);
    if (
      requirement.allowedPlayerAccess !== undefined &&
      !requirement.allowedPlayerAccess.includes(access.status)
    ) {
      return err(
        appError("PLAYER_INELIGIBLE", "Player access state does not allow this command", {
          userMessage: "Seu cadastro não permite usar este comando neste momento.",
        }),
      );
    }
    if (requirement.requiresMechanicalReady === true && player.value.state !== "COMPLETE") {
      return err(
        appError("FLOW_BLOCKED", "Player mechanical state is not ready for this command", {
          userMessage: "Conclua a preparação mecânica do treinador antes de usar este comando.",
        }),
      );
    }

    return ok(undefined);
  }
}
