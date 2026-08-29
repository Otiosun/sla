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
export function createInitialAuthCreds(): unknown;
export function serializeAuthValue(value: unknown): string;
export function deserializeAuthValue(serialized: string, keyType?: string | null): unknown;
