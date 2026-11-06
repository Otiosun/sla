import { type PlayerId, parsePlayerId } from "../shared-kernel/ids.js";

export interface OperationalExpeditionPreview {
  readonly timeZone: string;
  readonly playSecret?: Uint8Array;
  readonly allowedPlayerIds: ReadonlySet<PlayerId>;
}

/** Read-only admission. The staged write paths retain their independent guards. */
export function loadOperationalExpeditionPreview(
  env: NodeJS.ProcessEnv = process.env,
): OperationalExpeditionPreview | null {
  const flag = env.EXPEDITION_V4_PRIVATE_PREVIEW;
  const play = env.EXPEDITION_V4_PRIVATE_PLAY;
  if (play !== undefined && play !== "false" && play !== "true")
    throw new Error("EXPEDITION_V4_PRIVATE_PLAY must be true or false");
  if ((flag === undefined || flag === "false") && play !== "true") return null;
  if (flag !== undefined && flag !== "false" && flag !== "true")
    throw new Error("EXPEDITION_V4_PRIVATE_PREVIEW must be true or false");

  const allowedPlayerIds = new Set<PlayerId>();
  for (const token of (env.EXPEDITION_V4_ALLOWED_PLAYER_IDS ?? "").split(",")) {
    const player = parsePlayerId(token.trim().toLowerCase());
    if (!player.ok)
      throw new Error("EXPEDITION_V4_ALLOWED_PLAYER_IDS requires explicit player IDs");
    allowedPlayerIds.add(player.value);
  }
  const timeZone = env.EXPEDITION_V4_PREVIEW_TIME_ZONE ?? "America/Sao_Paulo";
  new Intl.DateTimeFormat("pt-BR", { timeZone });
  if (play !== "true") return { allowedPlayerIds, timeZone };
  const encoded = env.EXPEDITION_V4_PLAY_SECRET_BASE64 ?? "";
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== 32 || secret.toString("base64") !== encoded)
    throw new Error("EXPEDITION_V4_PLAY_SECRET_BASE64 must encode exactly 32 bytes");
  return { allowedPlayerIds, timeZone, playSecret: secret };
}
