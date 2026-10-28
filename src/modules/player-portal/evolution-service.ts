import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parsePokemonInstanceId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  OperationalEvolutionOptionView,
  OperationalUxReadModel,
} from "../messaging/operational-ux-read-model.js";
import { type ExternalIdentity, ExternalIdentitySchema } from "../player/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { EvolutionResult } from "../progression/contracts.js";
import type { ProgressionService } from "../progression/service.js";

const EvolutionRequestSchema = z
  .object({
    pokemonInstanceId: z.string().uuid(),
    requestId: z.string().uuid(),
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("LEVEL") }).strict(),
      z.object({ kind: z.literal("ITEM"), itemId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal("CONDITION") }).strict(),
    ]),
    recovery: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.trigger.kind === "LEVEL") !== (value.recovery === true)) {
      ctx.addIssue({ code: "custom", path: ["recovery"],
        message: "LEVEL is only allowed as an explicit overdue repair" });
    }
  });

interface PlayerPortalEvolutionDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly profiles: Pick<PlayerStarterService, "getProfile">;
  readonly reads: Pick<OperationalUxReadModel,
    "activeBattleId" | "listEvolutionOptions"> & Partial<Pick<OperationalUxReadModel, "listOwnedPokemon">>;
  readonly progression: Pick<ProgressionService, "evolvePokemon">;
}

/** Players may only evolve their own Pokémon. PostgreSQL re-checks ownership
 * and applies evolution + item consumption atomically and idempotently.
 * Do not expose administrative or arbitrary form-mutation operations here. */
export interface PlayerPortalEvolutionOptionsView {
  readonly blockedByBattle: boolean;
  readonly options: readonly (Omit<OperationalEvolutionOptionView, "itemQuantity"> & {
    readonly itemQuantity: string | null;
  })[];
}

export class PlayerPortalEvolutionService {
  public constructor(private readonly dependencies: PlayerPortalEvolutionDependencies) {}

  public async listOptions(
    identity: ExternalIdentity,
    pokemonInstanceId: unknown,
  ): Promise<Result<PlayerPortalEvolutionOptionsView>> {
    if (typeof pokemonInstanceId !== "string") {
      return err(appError("VALIDATION_FAILED", "Invalid Pokémon instance ID"));
    }
    const parsedPokemon = parsePokemonInstanceId(pokemonInstanceId);
    const who = ExternalIdentitySchema.safeParse(identity);
    if (!parsedPokemon.ok || !who.success) {
      return err(appError("VALIDATION_FAILED", "Invalid evolution lookup"));
    }
    const player = await this.dependencies.players.resolvePlayer(who.data);
    if (!player.ok) return player;
    const profile = await this.dependencies.profiles.getProfile(player.value.playerId);
    if (!profile.ok) return profile;
    if (profile.value.playerStatus !== "ACTIVE" || profile.value.onboardingState !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Player cannot view evolution options yet"));
    }
    if (!this.dependencies.reads.listEvolutionOptions) {
      return err(appError("FEATURE_UNAVAILABLE", "Evolution rules are unavailable"));
    }
    const [options, battleId] = await Promise.all([
      this.dependencies.reads.listEvolutionOptions(player.value.playerId, parsedPokemon.value),
      this.dependencies.reads.activeBattleId(player.value.playerId),
    ]);
    return ok({
      blockedByBattle: battleId !== null,
      options: options.map((option) => ({
        ...option,
        itemQuantity: option.itemQuantity === null ? null : option.itemQuantity.toString(),
      })),
    });
  }

  public async evolve(identity: ExternalIdentity, input: unknown): Promise<Result<EvolutionResult>> {
    const parsed = EvolutionRequestSchema.safeParse(input);
    const who = ExternalIdentitySchema.safeParse(identity);
    if (!parsed.success || !who.success) {
      return err(appError("VALIDATION_FAILED", "Invalid evolution request"));
    }
    // Normal LEVEL evolution is automatic; the only player-requested LEVEL
    // path here is the explicit historical repair flag validated by Zod.
    const player = await this.dependencies.players.resolvePlayer(who.data);
    if (!player.ok) return player;
    const profile = await this.dependencies.profiles.getProfile(player.value.playerId);
    if (!profile.ok) return profile;
    if (profile.value.playerStatus !== "ACTIVE" || profile.value.onboardingState !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Player cannot evolve Pokémon yet"));
    }
    if ((await this.dependencies.reads.activeBattleId(player.value.playerId)) !== null) {
      return err(appError("FLOW_BLOCKED", "Pokémon não podem evoluir durante uma batalha ativa."));
    }

    if (parsed.data.trigger.kind === "LEVEL") {
      const ownedReader = this.dependencies.reads.listOwnedPokemon;
      if (ownedReader === undefined) {
        return err(appError("FEATURE_UNAVAILABLE", "Revisão histórica indisponível."));
      }
      const [owned, rules] = await Promise.all([
        ownedReader.call(this.dependencies.reads, player.value.playerId),
        this.dependencies.reads.listEvolutionOptions(
          player.value.playerId, parsed.data.pokemonInstanceId,
        ),
      ]);
      const current = owned.find((p) => p.pokemonInstanceId === parsed.data.pokemonInstanceId);
      if (current === undefined) {
        return err(appError("NOT_FOUND", "Pokémon não encontrado na conta do treinador."));
      }
      if (!rules.some((rule) => rule.triggerKind === "LEVEL" &&
        rule.requiredLevel !== null && current.level >= rule.requiredLevel)) {
        return err(appError("ACTION_INVALID",
          "Nenhuma evolução por nível atrasada; a progressão normal é automática."));
      }
      // Current stats, final target and historical idempotency are validated
      // again inside the canonical Pokémon row-locked evolution transaction.
    }

    const evolved = await this.dependencies.progression.evolvePokemon({
      playerId: player.value.playerId,
      pokemonInstanceId: parsed.data.pokemonInstanceId,
      idempotencyKey: parsed.data.recovery === true
        ? `hub.evolution-repair:${player.value.playerId}:${parsed.data.requestId}`
        : `hub.evolution:${player.value.playerId}:${parsed.data.requestId}`,
      correlationId: randomUUID(),
      trigger: parsed.data.trigger,
    });
    if (evolved.ok) return ok(evolved.value);

    switch (evolved.error.code) {
      case "EVOLUTION_NOT_FOUND":
        return err(appError("NOT_FOUND", "Pokémon não encontrado na conta do treinador."));
      case "EVOLUTION_NOT_ELIGIBLE":
      case "EVOLUTION_ITEM_MISSING":
        return err(appError("ACTION_INVALID", evolved.error.message, {
          progressionCode: evolved.error.code,
        }));
      case "PROGRESSION_IDEMPOTENCY_CONFLICT":
        return err(appError("REVISION_CONFLICT", "Esta chave já foi usada em outra evolução."));
      case "PROGRESSION_INPUT_INVALID":
        return err(appError("VALIDATION_FAILED", evolved.error.message));
      default:
        return err(appError("FEATURE_UNAVAILABLE", "Evolução temporariamente indisponível."));
    }
  }
}
