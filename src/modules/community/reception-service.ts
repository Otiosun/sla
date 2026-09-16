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
      return "〔◌〕 *ANÁLISE EM ANDAMENTO*\n\nSua ficha já está com a equipe.\n\n> Nenhuma ação necessária agora.";
    case "CHANGES_REQUESTED":
      return "〔!〕 *AJUSTES SOLICITADOS*\n\nA equipe devolveu seu registro para correção.\n\n`/editar`\n\n> Altere apenas o que for necessário.";
    case "APPROVED":
      return "〔◉〕 *APROVAÇÃO CONFIRMADA*\n\nSua ficha passou. A liberação do treinador está sendo concluída, roto.";
    case "REJECTED":
      return "〔×〕 *REGISTRO REJEITADO*\n\nA revisão anterior da sua ficha não foi aprovada. Se quiser tentar novamente, você pode reabrir o registro preservado.\n\n`/editar`\n\n> Corrija o necessário e envie uma nova revisão.";
    case "WITHDRAWN":
      return "〔‹〕 *REVISÃO RETIRADA*\n\nA revisão anterior foi retirada.\n\n`/continuar` — retomar o registro\n`/ficha` — revisar a ficha";
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
        text: "〔⚡〕 𝗥𝗢𝗧𝗢𝗠𝗗𝗘𝗫\n*TREINADOR RECONHECIDO*\n\nRegistro ativo. Você continua ativo; sua jornada continua de onde parou.\n\n`/menu`\n\n> Abra sua Central do Treinador.",
      });
    }

    if (access.status === "SUSPENDED") {
      return ok({
        playerId,
        text: "〔!〕 *ACESSO SUSPENSO*\n\nSeu registro continua preservado, mas o acesso ao RPG está suspenso.\n\n> Procure a equipe responsável para regularizar o acesso.",
      });
    }

    const review = await this.dependencies.registration.getCurrentReview(playerId);
    if (!review.ok && review.error.code !== "NOT_FOUND") return err(review.error);

    if (review.ok) {
      if (review.value.status === "APPROVED" && access.status === "PROVISIONING") {
        return ok({
          playerId: playerId,
          text: "〔◉〕 *APROVAÇÃO CONFIRMADA*\n\nSua ficha passou. A liberação do treinador está sendo concluída, roto.",
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
        text: "〔▣〕 Você já possui um rascunho salvo. Use `/continuar` para retomar ou `/ficha` para revisar.",
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
