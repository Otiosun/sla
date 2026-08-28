import type {
  BaileysMessageContentLike,
  BaileysRuntimeBridge,
  BaileysSocketConfigLike,
  BaileysSocketLike,
} from "./baileys-provider-contracts.js";

export const loggedOutStatusCode: BaileysRuntimeBridge["loggedOutStatusCode"];
export function normalizeMessageContent(
  message: BaileysMessageContentLike | null | undefined,
): BaileysMessageContentLike | undefined;
export function makeSocket(config: BaileysSocketConfigLike): BaileysSocketLike;
