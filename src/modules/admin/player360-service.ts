import { z } from "zod";
import type { AdminService } from "./service.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import {
  Player360GetRequestSchema,
  Player360SearchRequestSchema,
  type Player360SearchCursor,
  type Player360SearchResultView,
  type Player360View,
} from "./player360-contracts.js";
import type { Player360ReadRepository } from "./player360-ports.js";

const Player360SearchCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    playerId: z.string().uuid(),
  })
  .strict();

function encodeCursor(cursor: Player360SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Player360SearchCursor | null {
  if (value === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const parsed = Player360SearchCursorSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("invalid cursor payload");
    return parsed.data;
  } catch {
    throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid Player 360 search cursor");
  }
}

export class Player360Service {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly repository: Player360ReadRepository,
  ) {}

  public async get(rawRequest: unknown): Promise<Player360View> {
    const parsed = Player360GetRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid Player 360 read request");
    }

    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "player.read",
      input: { playerId: parsed.data.playerId },
    });
    if (parsed.data.includeSensitive) {
      await this.authorizer.authorizeRead({
        principalId: parsed.data.principalId,
        operationType: "player.read_sensitive",
        input: { playerId: parsed.data.playerId },
      });
    }

    const view = await this.repository.getPlayer360(
      parsed.data.playerId,
      parsed.data.includeSensitive,
    );
    if (view === null) {
      throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Player not found");
    }
    return view;
  }

  public async search(rawRequest: unknown): Promise<Player360SearchResultView> {
    const parsed = Player360SearchRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid Player 360 search request");
    }

    await this.authorizer.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "player.search",
      input: {},
    });
    if (parsed.data.includeSensitive) {
      await this.authorizer.authorizeRead({
        principalId: parsed.data.principalId,
        operationType: "player.search_sensitive",
        input: {},
      });
    }

    const result = await this.repository.searchPlayers({
      status: parsed.data.status ?? null,
      trainerNamePrefix: parsed.data.trainerNamePrefix ?? null,
      originRegionId: parsed.data.originRegionId ?? null,
      identityProvider: parsed.data.identityProvider ?? null,
      externalId: parsed.data.externalId ?? null,
      includeSensitive: parsed.data.includeSensitive,
      limit: parsed.data.limit,
      cursor: decodeCursor(parsed.data.cursor),
    });
    const last = result.items.at(-1);
    return {
      items: result.items,
      nextCursor:
        result.hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, playerId: last.playerId })
          : null,
    };
  }
}
