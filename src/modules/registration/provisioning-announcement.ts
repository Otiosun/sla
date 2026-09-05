import type { PlayerId } from "../../shared-kernel/ids.js";

export interface PlayerActivationAnnouncementInput {
  readonly reviewId: string;
  readonly playerId: PlayerId;
  readonly trainerName: string;
}

export interface PlayerActivationAnnouncementPort {
  enqueueActivated(input: PlayerActivationAnnouncementInput): Promise<void>;
}

export function playerActivationAnnouncementIdempotencyKey(
  reviewId: string,
  groupId: string,
): string {
  return `registration-activated:${reviewId}:${groupId}`;
}
