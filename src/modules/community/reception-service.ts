import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { PlayerAccessRecord } from "../registration/player-access-ports.js";
import type { RegistrationRevisionStatus } from "../registration/ports.js";
import type { CommunityChatContext } from "./contracts.js";

interface ReceptionPlayerResolver {
  resolvePlayer(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<Result<{ readonly playerId: PlayerId }>>;
  resolveOrCreatePlayer(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<Result<{ readonly playerId: PlayerId }>>;
}

interface ReceptionRegistrationReader {
  getCurrentReview(
    playerId: PlayerId,
  ): Promise<Result<{ readonly status: RegistrationRevisionStatus }>>;
  getDraft(playerId: PlayerId): Promise<Result<{ readonly revision: number }>>;
}

interface ReceptionAccessReader {
  load(playerId: PlayerId): Promise<PlayerAccessRecord>;
}

interface ReceptionPresenceWriter {
  needsFirstWelcome(input: {
    readonly groupId: string;
    readonly playerId: PlayerId;
  }): Promise<boolean>;
  claimFirstWelcome(input: {
    readonly groupId: string;
    readonly playerId: PlayerId;
  }): Promise<boolean>;
}

interface ReceptionCommunityResolver {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<CommunityChatContext>;
}

export interface ReceptionServiceDependencies {
  readonly community: ReceptionCommunityResolver;
  readonly players: ReceptionPlayerResolver;
  readonly registration: ReceptionRegistrationReader;
  readonly access: ReceptionAccessReader;
  readonly presence: ReceptionPresenceWriter;
}

export interface ReceptionFirstInteractionInput {
  readonly provider: string;
  readonly chatRef: string;
  readonly externalId: string;
}

export interface ReceptionWelcome {
  readonly playerId: PlayerId;
  readonly text: string;
  readonly newTrainer?: boolean;
}

export function isReception(group: CommunityChatContext): group is CommunityChatContext & {
  readonly known: true;
  readonly groupId: string;
} {
  return (
    group.known &&
    group.groupId !== null &&
    group.role === "RECEPTION" &&
    group.capabilities.includes("onboarding")
  );
}

function reviewText(status: RegistrationRevisionStatus): string {
  switch (status) {
    case "SUBMITTED":
      return "📨 Sua ficha já foi enviada e está em análise pela equipe. Aguarde a revisão.";
    case "CHANGES_REQUESTED":
      return "✏️ A equipe pediu ajustes na sua ficha. Use `/editar` para alterar somente o necessário.";
    case "APPROVED":
      return "✅ Sua ficha foi aprovada. A liberação do personagem está sendo concluída.";
    case "REJECTED":
      return "⛔ Sua ficha foi rejeitada. O estado foi preservado para acompanhamento da equipe.";
    case "WITHDRAWN":
      return "↩️ A revisão anterior foi retirada. Use `/continuar` ou `/ficha` para retomar sua ficha.";
  }
}

export class ReceptionService {
  public constructor(private readonly dependencies: ReceptionServiceDependencies) {}

  public async admitsFirstInteraction(input: ReceptionFirstInteractionInput): Promise<boolean> {
    const group = await this.dependencies.community.resolveChat({
      provider: input.provider,
      chatRef: input.chatRef,
    });
    if (!isReception(group)) return false;

    const player = await this.dependencies.players.resolvePlayer({
      provider: input.provider,
      externalId: input.externalId,
    });
    if (!player.ok) return player.error.code === "NOT_FOUND";

    return this.dependencies.presence.needsFirstWelcome({
      groupId: group.groupId,
      playerId: player.value.playerId,
    });
  }

  public async firstInteraction(
    input: ReceptionFirstInteractionInput,
  ): Promise<Result<ReceptionWelcome | null>> {
    const group = await this.dependencies.community.resolveChat({
      provider: input.provider,
      chatRef: input.chatRef,
    });
    if (!isReception(group)) return ok(null);

    const player = await this.dependencies.players.resolveOrCreatePlayer({
      provider: input.provider,
      externalId: input.externalId,
    });
    if (!player.ok) return player;

    const welcome = await this.welcomeForPlayer(player.value.playerId, input.externalId);
    if (!welcome.ok) return welcome;
    const claimed = await this.dependencies.presence.claimFirstWelcome({
      groupId: group.groupId,
      playerId: player.value.playerId,
    });
    if (!claimed) return ok(null);

    return welcome;
  }

  public async welcomeForPlayer(
    playerId: PlayerId,
    externalId: string,
  ): Promise<Result<ReceptionWelcome>> {
    const access = await this.dependencies.access.load(playerId);

    if (access.status === "ACTIVE") {
      return ok({
        playerId: playerId,
        text: "👋 Bem-vindo de volta à Recepção. Seu personagem continua ativo; nenhum cadastro foi reiniciado.",
      });
    }

    const review = await this.dependencies.registration.getCurrentReview(playerId);
    if (!review.ok && review.error.code !== "NOT_FOUND") return err(review.error);

    if (review.ok) {
      if (review.value.status === "APPROVED" && access.status === "PROVISIONING") {
        return ok({
          playerId: playerId,
          text: "✅ Sua ficha foi aprovada. A liberação do personagem está em provisionamento e será concluída sem refazer o cadastro.",
        });
      }
      return ok({
        playerId: playerId,
        text: reviewText(review.value.status),
      });
    }

    const draft = await this.dependencies.registration.getDraft(playerId);
    if (!draft.ok && draft.error.code !== "NOT_FOUND") return err(draft.error);
    if (draft.ok) {
      return ok({
        playerId: playerId,
        text: "📋 Você já possui um rascunho salvo. Use `/continuar` para retomar ou `/ficha` para revisar.",
      });
    }

    if (access.status !== "PENDING") {
      return err(
        appError("INVALID_STATE_TRANSITION", "Reception state is inconsistent with player access"),
      );
    }

    return ok({
      playerId: playerId,
      newTrainer: true,
      text: [
        "🚨[ *BZZZT... BZZZT!* ]",
        "",
        `❗\`NOVO TREINADOR DETECTADO: @${externalId.split("@")[0]}\`❗`,
        "",
        "Eu sou Rotom! Pokédex autoaprendiz, especialista em Pokémon, treinadores e... praticamente tudo que importa por aqui, *roto!*",
        "",
        "Só tem um problema:",
        "",
        "> *Eu não faço ideia de quem é você.*",
        "",
        "E isso é péssimo para uma Pokédex. ⚡ Vamos corrigir isso! *Digite:*",
        "",
        "`/registrar`",
        "",
        "*Não fica parado aí!* Meu banco de dados não vai se preencher sozinho! ⚡",
      ].join("\n"),
    });
  }
}
