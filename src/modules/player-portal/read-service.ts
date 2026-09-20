import type { PlayerId, PokemonInstanceId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { BattleState } from "../battle/contracts.js";
import type { OperationalUxReadModel } from "../messaging/operational-ux-read-model.js";
import type { ExternalIdentity, PlayerProfileView } from "../player/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { WorldLocationView } from "../world/contracts.js";
import type { WorldService } from "../world/service.js";

export interface PlayerPortalMoveView {
  readonly slotNo: number;
  readonly moveId: string;
  readonly displayName: string | null;
  readonly typeName: string | null;
  readonly category: "PHYSICAL" | "SPECIAL" | "STATUS" | null;
  readonly power: number | null;
  readonly accuracy: number | null;
  readonly ppCurrent: number | null;
  readonly maxPp: number | null;
}

export interface PlayerPortalPokemonIvView {
  readonly hp: number | null;
  readonly attack: number | null;
  readonly defense: number | null;
  readonly spAttack: number | null;
  readonly spDefense: number | null;
  readonly speed: number | null;
}

export interface PlayerPortalPokemonView {
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly formId: string;
  readonly formSlug: string;
  readonly speciesSlug: string;
  readonly displayName: string | null;
  readonly nationalDex: number | null;
  readonly typeNames: readonly string[];
  readonly nickname: string | null;
  readonly level: number;
  readonly xp: string;
  readonly xpToNextLevel: number;
  readonly currentHp: number;
  readonly maxHp: number | null;
  readonly natureDisplayName: string | null;
  readonly abilityDisplayName: string | null;
  readonly ivs: PlayerPortalPokemonIvView;
  readonly gender: string | null;
  readonly shiny: boolean;
  readonly placementKind: "TEAM" | "BOX";
  readonly boxNo: number | null;
  readonly slotNo: number;
  readonly conditions: readonly string[];
  readonly moves: readonly PlayerPortalMoveView[];
}

export interface PlayerPortalPokedexSpeciesView {
  readonly speciesId: string;
  readonly nationalDex: number;
  readonly speciesSlug: string;
  readonly displayName: string;
  readonly seenCount: string;
  readonly caughtCount: string;
  readonly shinySeenCount: string;
  readonly shinyCaughtCount: string;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly firstCaughtAt: string | null;
  readonly lastCaughtAt: string | null;
  readonly firstShinySeenAt: string | null;
  readonly lastShinySeenAt: string | null;
  readonly firstShinyCaughtAt: string | null;
  readonly lastShinyCaughtAt: string | null;
}

export interface PlayerPortalInventoryItemView {
  readonly itemId: string;
  readonly itemSlug: string;
  readonly displayName: string;
  readonly quantity: string;
}

export interface PlayerPortalTeamView {
  readonly pokemonInstanceId: PokemonInstanceId;
  readonly formId: string;
  readonly formSlug: string;
  readonly speciesSlug: string;
  readonly displayName: string | null;
  readonly nationalDex: number | null;
  readonly typeNames: readonly string[];
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number | null;
  readonly shiny: boolean;
  readonly slotNo: number;
  readonly conditions: readonly string[];
  readonly moves: readonly PlayerPortalMoveView[];
}

export type PlayerPortalSelfView = Omit<PlayerProfileView, "progressionPoints" | "team"> & {
  readonly progressionPoints: string;
  readonly originRegionName: string | null;
  readonly team: readonly PlayerPortalTeamView[];
};

export interface PlayerPortalWorldConnectionView {
  readonly connectionId: string;
  readonly connectionKey: string;
  readonly destinationAreaId: string;
  readonly destinationSlug: string;
  readonly destinationDisplayName: string;
  readonly available: boolean;
}

export interface PlayerPortalWorldLocationView {
  readonly areaId: string;
  readonly areaSlug: string;
  readonly areaDisplayName: string;
  readonly regionId: string;
  readonly regionSlug: string;
  readonly regionDisplayName: string;
  readonly safePoint: boolean;
  readonly revision: string;
  readonly enteredAt: string;
  readonly requiresRelocation: boolean;
  readonly relocationAreaId: string | null;
  readonly connections: readonly PlayerPortalWorldConnectionView[];
}

export interface PlayerPortalBattleMoveView {
  readonly slotNo: number;
  readonly displayName: string | null;
  readonly ppCurrent: number | null;
  readonly maxPp: number | null;
}

export interface PlayerPortalBattleCombatantView {
  readonly sideNo: number;
  readonly playerSide: boolean;
  readonly active: boolean;
  readonly displayName: string | null;
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly conditions: readonly string[];
  readonly moves: readonly PlayerPortalBattleMoveView[];
}

export interface PlayerPortalBattleView {
  readonly battleType: "WILD" | "NPC" | "PVP";
  readonly status:
    | "CREATED"
    | "ACTIVE"
    | "RESOLVING_TURN"
    | "WON"
    | "LOST"
    | "FLED"
    | "DRAW"
    | "CANCELLED";
  readonly turnNumber: number;
  readonly playerSideNo: number;
  readonly combatants: readonly PlayerPortalBattleCombatantView[];
}

export interface PlayerPortalActiveBattleRecord {
  readonly state: BattleState;
  readonly playerSideNo: number;
}

export interface PlayerPortalReadRepository {
  originRegionDisplayName(
    contentReleaseId: string,
    originRegionId: string | null,
  ): Promise<string | null>;
  listOwnedPokemon(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PlayerPortalPokemonView[]>;
  listPokedex(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PlayerPortalPokedexSpeciesView[]>;
  listInventory(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PlayerPortalInventoryItemView[]>;
  activeBattle(playerId: PlayerId): Promise<PlayerPortalActiveBattleRecord | null>;
}

interface PlayerPortalReadDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly profiles: Pick<PlayerStarterService, "getProfile">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly repository: PlayerPortalReadRepository;
  readonly presentation: Pick<OperationalUxReadModel, "speciesDisplayName" | "moveDisplayNames">;
}

interface EligiblePlayer {
  readonly playerId: PlayerId;
  readonly profile: PlayerProfileView;
}

export class PlayerPortalReadService {
  public constructor(private readonly dependencies: PlayerPortalReadDependencies) {}

  public async getSelf(identity: ExternalIdentity): Promise<Result<PlayerPortalSelfView>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    const pokemon = await this.dependencies.repository.listOwnedPokemon(
      eligible.value.playerId,
      eligible.value.profile.contentReleaseId,
    );
    const originRegionName = await this.dependencies.repository.originRegionDisplayName(
      eligible.value.profile.contentReleaseId,
      eligible.value.profile.originRegionId,
    );

    return ok({
      ...eligible.value.profile,
      progressionPoints: eligible.value.profile.progressionPoints.toString(),
      originRegionName,
      team: pokemon
        .filter((entry) => entry.placementKind === "TEAM")
        .sort((left, right) => left.slotNo - right.slotNo)
        .map((entry) => ({
          pokemonInstanceId: entry.pokemonInstanceId,
          formId: entry.formId,
          formSlug: entry.formSlug,
          speciesSlug: entry.speciesSlug,
          displayName: entry.displayName,
          nationalDex: entry.nationalDex,
          typeNames: entry.typeNames,
          level: entry.level,
          currentHp: entry.currentHp,
          maxHp: entry.maxHp,
          shiny: entry.shiny,
          slotNo: entry.slotNo,
          conditions: entry.conditions,
          moves: entry.moves,
        })),
    });
  }

  public async getPokemon(
    identity: ExternalIdentity,
  ): Promise<Result<readonly PlayerPortalPokemonView[]>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    return ok(
      await this.dependencies.repository.listOwnedPokemon(
        eligible.value.playerId,
        eligible.value.profile.contentReleaseId,
      ),
    );
  }

  public async getPokedex(
    identity: ExternalIdentity,
  ): Promise<Result<readonly PlayerPortalPokedexSpeciesView[]>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    return ok(
      await this.dependencies.repository.listPokedex(
        eligible.value.playerId,
        eligible.value.profile.contentReleaseId,
      ),
    );
  }

  public async getInventory(
    identity: ExternalIdentity,
  ): Promise<Result<readonly PlayerPortalInventoryItemView[]>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    return ok(
      await this.dependencies.repository.listInventory(
        eligible.value.playerId,
        eligible.value.profile.contentReleaseId,
      ),
    );
  }

  public async getLocation(
    identity: ExternalIdentity,
  ): Promise<Result<PlayerPortalWorldLocationView>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    const location = await this.dependencies.world.getLocation(eligible.value.playerId);
    if (!location.ok) return location;
    return ok(worldLocationView(location.value));
  }

  public async getBattle(
    identity: ExternalIdentity,
  ): Promise<Result<PlayerPortalBattleView | null>> {
    const eligible = await this.resolveEligible(identity);
    if (!eligible.ok) return eligible;

    const active = await this.dependencies.repository.activeBattle(eligible.value.playerId);
    if (active === null) return ok(null);

    const speciesIds = [
      ...new Set(active.state.combatants.map((combatant) => combatant.speciesId)),
    ];
    const speciesNames = new Map<string, string | null>();
    await Promise.all(
      speciesIds.map(async (speciesId) => {
        speciesNames.set(
          speciesId,
          await this.dependencies.presentation.speciesDisplayName(
            active.state.contentReleaseId,
            speciesId,
          ),
        );
      }),
    );

    const moveIds = [
      ...new Set(
        active.state.combatants.flatMap((combatant) => combatant.moves.map((move) => move.moveId)),
      ),
    ];
    const moveNames = await this.dependencies.presentation.moveDisplayNames(
      active.state.contentReleaseId,
      moveIds,
    );

    const activeBySide = new Map(
      active.state.sides.map((side) => [side.sideNo, side.activeParticipantId] as const),
    );

    return ok({
      battleType: active.state.battleType,
      status: active.state.status,
      turnNumber: active.state.turnNumber,
      playerSideNo: active.playerSideNo,
      combatants: active.state.combatants.map((combatant) => ({
        sideNo: combatant.sideNo,
        playerSide: combatant.sideNo === active.playerSideNo,
        active: activeBySide.get(combatant.sideNo) === combatant.participantId,
        displayName: speciesNames.get(combatant.speciesId) ?? null,
        level: combatant.level,
        currentHp: combatant.currentHp,
        maxHp: combatant.maxHp,
        conditions: combatant.majorStatus === null ? [] : [combatant.majorStatus.key],
        moves: combatant.moves.map((move) => ({
          slotNo: move.slotNo,
          displayName: moveNames.get(move.moveId) ?? null,
          ppCurrent: move.ppCurrent,
          maxPp: move.maxPp,
        })),
      })),
    });
  }

  private async resolveEligible(identity: ExternalIdentity): Promise<Result<EligiblePlayer>> {
    const resolved = await this.dependencies.players.resolvePlayer(identity);
    if (!resolved.ok) return resolved;

    const profile = await this.dependencies.profiles.getProfile(resolved.value.playerId);
    if (!profile.ok) return profile;
    if (profile.value.playerStatus !== "ACTIVE" || profile.value.onboardingState !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access"));
    }

    return ok({ playerId: resolved.value.playerId, profile: profile.value });
  }
}

function worldLocationView(location: WorldLocationView): PlayerPortalWorldLocationView {
  return {
    areaId: location.areaId,
    areaSlug: location.areaSlug,
    areaDisplayName: location.areaDisplayName,
    regionId: location.regionId,
    regionSlug: location.regionSlug,
    regionDisplayName: location.regionDisplayName,
    safePoint: location.safePoint,
    revision: location.revision.toString(),
    enteredAt: location.enteredAt.toISOString(),
    requiresRelocation: location.requiresRelocation,
    relocationAreaId: location.relocationAreaId,
    connections: location.connections.map((connection) => ({
      connectionId: connection.connectionId,
      connectionKey: connection.connectionKey,
      destinationAreaId: connection.destinationAreaId,
      destinationSlug: connection.destinationSlug,
      destinationDisplayName: connection.destinationDisplayName,
      available: connection.available,
    })),
  };
}
