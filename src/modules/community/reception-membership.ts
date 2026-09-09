import type { PlayerId } from "../../shared-kernel/ids.js";
import {
  isReception,
  type ReceptionService,
  type ReceptionServiceDependencies,
} from "./reception-service.js";

export interface ReceptionMembershipEvent {
  readonly provider: "baileys";
  readonly chatRef: string;
  readonly externalId: string;
  readonly action: "add" | "remove";
}

export interface ReceptionMembershipInput {
  readonly groupId: string;
  readonly playerId: PlayerId;
  readonly chatRef: string;
  readonly action: "add" | "remove";
}

export interface ReceptionMembershipMessage {
  readonly messageType: "TEXT" | "IMAGE";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReceptionMembershipRepository {
  recordMembership(
    input: ReceptionMembershipInput,
    welcome: () => Promise<ReceptionMembershipMessage>,
  ): Promise<void>;
}

// The original image supplied for Reception, versioned without modification.
export const ROTOM_WELCOME_IMAGE_URL =
  "https://raw.githubusercontent.com/Otiosun/sla/c041ed9ab80fdaf1156c14867d14147053641aaa/assets/reception/rotom-welcome.jpg";

export class ReceptionMembershipService {
  public constructor(
    private readonly dependencies: Pick<ReceptionServiceDependencies, "community" | "players"> & {
      readonly reception: ReceptionService;
      readonly presence: ReceptionMembershipRepository;
    },
  ) {}

  public async handle(event: ReceptionMembershipEvent): Promise<void> {
    const group = await this.dependencies.community.resolveChat(event);
    if (!isReception(group)) return;
    const identity = { provider: event.provider, externalId: event.externalId };
    // A leave never creates a player and never changes access, draft or approval.
    const player =
      event.action === "add"
        ? await this.dependencies.players.resolveOrCreatePlayer(identity)
        : await this.dependencies.players.resolvePlayer(identity);
    if (!player.ok) {
      if (event.action === "remove" && player.error.code === "NOT_FOUND") return;
      throw new Error(`Reception identity failed: ${player.error.code}`);
    }
    await this.dependencies.presence.recordMembership(
      {
        groupId: group.groupId,
        playerId: player.value.playerId,
        chatRef: event.chatRef,
        action: event.action,
      },
      async () => {
        const welcome = await this.dependencies.reception.welcomeForPlayer(
          player.value.playerId,
          event.externalId,
        );
        if (!welcome.ok) throw new Error(`Reception welcome failed: ${welcome.error.code}`);
        const mentions = [event.externalId];
        return welcome.value.newTrainer === true
          ? {
              messageType: "IMAGE",
              payload: { imageUrl: ROTOM_WELCOME_IMAGE_URL, caption: welcome.value.text, mentions },
            }
          : {
              messageType: "TEXT",
              payload: {
                text: `@${event.externalId.split("@")[0]}\n\n${welcome.value.text}`,
                mentions,
              },
            };
      },
    );
  }
}
