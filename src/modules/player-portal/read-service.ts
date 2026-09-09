import {
  ExternalIdentitySchema,
  type ExternalIdentity,
  type PlayerProfileView,
} from "../player/contracts.js";
import type { OwnedPokemonRecord, PlayerOnboardingRepository } from "../player/ports.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface PlayerPortalCatalogResolveInput {
  readonly contentReleaseId: string;
  readonly originRegionId: string | null;
  readonly formIds: readonly string[];
}

export interface PlayerPortalCatalogFormView {
  readonly formId: string;
  readonly displayName: string;
  readonly nationalDex: number;
  readonly typeNames: readonly string[];
}

export interface PlayerPortalCatalogView {
  readonly originRegionName: string | null;
  readonly forms: readonly PlayerPortalCatalogFormView[];
}

export interface PlayerPortalCatalogResolver {
  resolve(input: PlayerPortalCatalogResolveInput): Promise<PlayerPortalCatalogView>;
}

export type PlayerPortalTeamView = PlayerProfileView["team"][number] & {
  readonly displayName: string | null;
  readonly nationalDex: number | null;
  readonly typeNames: readonly string[];
};

export type PlayerPortalPokemonView = OwnedPokemonRecord & {
  readonly displayName: string | null;
  readonly nationalDex: number | null;
  readonly typeNames: readonly string[];
};

export type PlayerPortalSelfView = Omit<PlayerProfileView, "progressionPoints" | "team"> & {
  readonly progressionPoints: string;
  readonly originRegionName: string | null;
  readonly team: readonly PlayerPortalTeamView[];
};

const EMPTY_CATALOG_RESOLVER: PlayerPortalCatalogResolver = {
  resolve: async () => ({ originRegionName: null, forms: [] }),
};

export class PlayerPortalReadService {
  public constructor(
    private readonly repository: PlayerOnboardingRepository,
    private readonly catalog: PlayerPortalCatalogResolver = EMPTY_CATALOG_RESOLVER,
  ) {}

  public async getSelf(identity: ExternalIdentity): Promise<Result<PlayerPortalSelfView>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid external identity"));
    }

    const profileResult = await this.repository.read(async (transaction) => {
      const playerId = await transaction.findPlayerByIdentity(parsedIdentity.data);
      if (playerId === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }

      const profile = await transaction.loadProfileView(playerId);
      if (profile === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }
      if (profile.playerStatus !== "ACTIVE") {
        return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
      }

      return ok(profile);
    });

    if (!profileResult.ok) return profileResult;
    const profile = profileResult.value;
    const catalog = await this.catalog.resolve({
      contentReleaseId: profile.contentReleaseId,
      originRegionId: profile.originRegionId,
      formIds: [...new Set(profile.team.map((member) => member.formId))],
    });
    const formsById = new Map(catalog.forms.map((form) => [form.formId, form] as const));

    return ok({
      ...profile,
      progressionPoints: profile.progressionPoints.toString(),
      originRegionName: catalog.originRegionName,
      team: profile.team.map((member) => {
        const presentation = formsById.get(member.formId);
        return {
          ...member,
          displayName: presentation?.displayName ?? null,
          nationalDex: presentation?.nationalDex ?? null,
          typeNames: presentation?.typeNames ?? [],
        };
      }),
    });
  }

  public async getPokemon(
    identity: ExternalIdentity,
  ): Promise<Result<readonly PlayerPortalPokemonView[]>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid external identity"));
    }

    const ownedResult = await this.repository.read(async (transaction) => {
      const playerId = await transaction.findPlayerByIdentity(parsedIdentity.data);
      if (playerId === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }

      const profile = await transaction.loadProfileView(playerId);
      if (profile === null) {
        return err(appError("NOT_FOUND", "Player portal profile unavailable"));
      }
      if (profile.playerStatus !== "ACTIVE") {
        return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
      }

      const pokemon = await transaction.listOwnedPokemon(playerId);
      return ok({ contentReleaseId: profile.contentReleaseId, pokemon });
    });

    if (!ownedResult.ok) return ownedResult;

    const catalog = await this.catalog.resolve({
      contentReleaseId: ownedResult.value.contentReleaseId,
      originRegionId: null,
      formIds: [...new Set(ownedResult.value.pokemon.map((pokemon) => pokemon.formId))],
    });
    const formsById = new Map(catalog.forms.map((form) => [form.formId, form] as const));

    return ok(
      ownedResult.value.pokemon.map((pokemon) => {
        const presentation = formsById.get(pokemon.formId);
        return {
          ...pokemon,
          displayName: presentation?.displayName ?? null,
          nationalDex: presentation?.nationalDex ?? null,
          typeNames: presentation?.typeNames ?? [],
        };
      }),
    );
  }
}
