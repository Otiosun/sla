import type { PlayerId } from "../../shared-kernel/ids.js";
import type { CommunityService } from "../community/service.js";
import type { PlayerAccessRecord } from "../registration/player-access-ports.js";

/**
 * Server-owned exploration group authorization, not a new community role.
 * This delegates to the SAME group capabilities used by World/PvE/PvP.
 *
 * No WhatsApp route is registered by constructing this object.
 * Re-evaluate per reply; never cache group/player permissions in a menu.
 */
export class IncidentalGameGroupAdmission {
  public constructor(
    private readonly community: Pick<CommunityService, "resolveChat">,
    private readonly access: {
      load(playerId: PlayerId): Promise<PlayerAccessRecord>;
    },
  ) {}

  public async admits(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly playerId: PlayerId;
  }): Promise<boolean> {
    if (input.provider !== "baileys" || !/^[0-9]+@g\.us$/u.test(input.chatRef)) return false;
    try {
      const group = await this.community.resolveChat({
        provider: input.provider,
        chatRef: input.chatRef,
      });
      if (
        !group.known ||
        group.role !== "GAME" ||
        !group.capabilities.includes("world") ||
        !group.capabilities.includes("player.basic")
      )
        return false;
      const player = await this.access.load(input.playerId);
      return player.playerId === input.playerId && player.status === "ACTIVE";
    } catch {
      // Any failed read must DENY. The caller can separately log DB health.
      return false;
    }
  }
}
