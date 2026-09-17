import {
  validateZhouliaContentBundle,
  ZHOULIA_TYPED_CONTENT_V1,
  type ZhouliaAreaContent,
  type ZhouliaContentBundle,
  type ZhouliaEncounterPool,
} from "./zhoulia-content.js";

export interface ZhouliaWorldAreaConfig {
  readonly schemaVersion: 1;
  readonly kind: "TOWN" | "ROUTE";
  readonly safePoint: boolean;
  readonly startingArea: boolean;
  readonly relocationPriority: number;
  readonly facilities: readonly ("POKEMART" | "POKEMON_CENTER")[];
  readonly presentation: {
    readonly summary: string;
    readonly narrativeKeys: {
      readonly firstArrival?: string;
      readonly returnArrival?: string;
    };
    readonly sites: readonly {
      readonly identity: string;
      readonly displayName: string;
      readonly kind: string;
    }[];
    readonly npcRoles: readonly {
      readonly identity: string;
      readonly roleKey: string;
      readonly displayName: string | null;
      readonly locationIdentity: string;
    }[];
    readonly editorialNotes: readonly string[];
  };
}

export interface ZhouliaEncounterCatalogConditions {
  readonly schemaVersion: 1;
  readonly requiredUnlockKeys: readonly string[];
  readonly blockedUnlockKeys: readonly string[];
  readonly timeOfDay?: "DAY" | "NIGHT";
  readonly surface?: "LAND" | "WATER";
  readonly rarity?: "COMMON" | "RARE";
  readonly weatherKey?: string;
}

export interface ZhouliaEncounterPoolDraftPlan {
  readonly identity: string;
  readonly areaIdentity: string;
  readonly tableSlug: string;
  readonly label: string;
  readonly conditions: ZhouliaEncounterCatalogConditions;
  readonly speciesKeys: readonly string[];
  readonly balanceStatus: "PENDING_LEVELS_AND_WEIGHTS";
}

export interface ZhouliaDirectedRoutePlan {
  readonly identity: string;
  readonly fromAreaIdentity: string;
  readonly toAreaIdentity: string;
  readonly connectionKey: string;
  readonly accessRule: {
    readonly schemaVersion: 1;
    readonly requiredUnlockKeys: readonly string[];
  };
}

function slugFromIdentity(identity: string): string {
  const segment = identity.split(".").at(-1);
  if (segment === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(segment)) {
    throw new Error(`Invalid semantic identity tail: ${identity}`);
  }
  return segment;
}

export function zhouliaAreaSlug(area: ZhouliaAreaContent): string {
  return slugFromIdentity(area.identity);
}

function encounterPoolTableSlug(areaIdentity: string, poolIdentity: string): string {
  const areaSlug = slugFromIdentity(areaIdentity);
  const prefix = `zhoulia.encounter-pool.${areaSlug}.`;
  if (!poolIdentity.startsWith(prefix)) {
    throw new Error(`Encounter pool ${poolIdentity} does not belong to ${areaIdentity}`);
  }
  const suffix = poolIdentity.slice(prefix.length);
  const slug = suffix.replaceAll(".", "-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 63) {
    throw new Error(`Invalid encounter table slug from ${poolIdentity}`);
  }
  return slug;
}

export function zhouliaWorldAreaConfig(
  area: ZhouliaAreaContent,
  areaIndex: number,
): ZhouliaWorldAreaConfig {
  const isVila = area.identity === "zhoulia.area.vila-dos-arrozais";
  const facilities = area.sites.flatMap((site) => {
    if (site.kind === "POKEMON_CENTER") return ["POKEMON_CENTER"] as const;
    if (site.kind === "POKEMART") return ["POKEMART"] as const;
    return [];
  });
  return {
    schemaVersion: 1,
    kind: isVila ? "TOWN" : "ROUTE",
    safePoint: isVila,
    startingArea: isVila,
    relocationPriority: areaIndex * 10,
    facilities,
    presentation: {
      summary: area.summary,
      narrativeKeys: { ...area.narrativeKeys },
      sites: area.sites.map((site) => ({ ...site })),
      npcRoles: area.npcRoles.map((npc) => ({ ...npc })),
      editorialNotes: [...area.editorialNotes],
    },
  };
}

export function zhouliaEncounterConditions(
  pool: ZhouliaEncounterPool,
): ZhouliaEncounterCatalogConditions {
  let timeOfDay: "DAY" | "NIGHT" | undefined;
  let surface: "LAND" | "WATER" | undefined;
  let rarity: "COMMON" | "RARE" | undefined;
  let weatherKey: string | undefined;

  for (const condition of pool.conditions) {
    if (condition.kind === "TIME_OF_DAY") {
      if (timeOfDay !== undefined) throw new Error(`Duplicate TIME_OF_DAY in ${pool.identity}`);
      timeOfDay = condition.value;
    } else if (condition.kind === "SURFACE") {
      if (surface !== undefined) throw new Error(`Duplicate SURFACE in ${pool.identity}`);
      surface = condition.value;
    } else if (condition.kind === "RARITY") {
      if (rarity !== undefined) throw new Error(`Duplicate RARITY in ${pool.identity}`);
      rarity = condition.value;
    } else {
      if (weatherKey !== undefined) throw new Error(`Duplicate WEATHER in ${pool.identity}`);
      weatherKey = condition.value;
    }
  }

  return {
    schemaVersion: 1,
    requiredUnlockKeys: [],
    blockedUnlockKeys: [],
    ...(timeOfDay === undefined ? {} : { timeOfDay }),
    ...(surface === undefined ? {} : { surface }),
    ...(rarity === undefined ? {} : { rarity }),
    ...(weatherKey === undefined ? {} : { weatherKey }),
  };
}

export function buildZhouliaEncounterPoolDraftPlans(
  bundle: ZhouliaContentBundle = ZHOULIA_TYPED_CONTENT_V1,
): readonly ZhouliaEncounterPoolDraftPlan[] {
  validateZhouliaContentBundle(bundle);
  return bundle.areas.flatMap((area) =>
    area.encounterPools.map((pool) => ({
      identity: pool.identity,
      areaIdentity: area.identity,
      tableSlug: encounterPoolTableSlug(area.identity, pool.identity),
      label: pool.label,
      conditions: zhouliaEncounterConditions(pool),
      speciesKeys: pool.entries.map((entry) => entry.speciesKey),
      balanceStatus: "PENDING_LEVELS_AND_WEIGHTS" as const,
    })),
  );
}

export function buildZhouliaDirectedRoutes(
  bundle: ZhouliaContentBundle = ZHOULIA_TYPED_CONTENT_V1,
): readonly ZhouliaDirectedRoutePlan[] {
  validateZhouliaContentBundle(bundle);
  return bundle.routes.flatMap((route) => {
    const fromSlug = slugFromIdentity(route.fromAreaIdentity);
    const toSlug = slugFromIdentity(route.toAreaIdentity);
    return [
      {
        identity: `${route.identity}.forward`,
        fromAreaIdentity: route.fromAreaIdentity,
        toAreaIdentity: route.toAreaIdentity,
        connectionKey: `${fromSlug}-to-${toSlug}`,
        accessRule: { schemaVersion: 1, requiredUnlockKeys: [] },
      },
      {
        identity: `${route.identity}.reverse`,
        fromAreaIdentity: route.toAreaIdentity,
        toAreaIdentity: route.fromAreaIdentity,
        connectionKey: `${toSlug}-to-${fromSlug}`,
        accessRule: { schemaVersion: 1, requiredUnlockKeys: [] },
      },
    ];
  });
}
