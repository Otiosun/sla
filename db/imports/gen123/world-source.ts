import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CsvRow } from "./source.js";
import { requiredInt, requiredText } from "./source.js";

export const GEN123_WORLD_SOURCES = {
  firered: {
    provider: "pret/pokefirered",
    commit: "c75f352304d529f6ba92d4f74b9cf8b5c3810788",
    env: "POKEFIRERED_DIR",
  },
  crystal: {
    provider: "pret/pokecrystal",
    commit: "7a7881d0d62e0ddbd82dcf10e7116807487ac651",
    env: "POKECRYSTAL_DIR",
  },
  emerald: {
    provider: "pret/pokeemerald",
    commit: "c65e93f20a5275ab03b07d6f6411096a82a60ffd",
    env: "POKEEMERALD_DIR",
  },
} as const;

export type Gen123WorldSourceKey = keyof typeof GEN123_WORLD_SOURCES;

export interface Gen123WorldEdge {
  readonly fromSlug: string;
  readonly toSlug: string;
  readonly connectionKey: "north" | "south" | "west" | "east" | "warp";
  readonly source: Gen123WorldSourceKey;
}

export interface Gen123WorldTopology {
  readonly locationSlugs: ReadonlySet<string>;
  readonly edges: readonly Gen123WorldEdge[];
  readonly sourceLocationCounts: Readonly<Record<Gen123WorldSourceKey, number>>;
  readonly sourceEdgeCounts: Readonly<Record<Gen123WorldSourceKey, number>>;
}

type Direction = "north" | "south" | "west" | "east";
type GbaDirection = Direction | "up" | "down" | "left" | "right";

type GbaMap = {
  readonly id: string;
  readonly name: string;
  readonly region_map_section: string;
  readonly connections?:
    | readonly { readonly map: string; readonly direction: GbaDirection }[]
    | null;
  readonly warp_events?: readonly { readonly dest_map: string }[] | null;
};

interface ParsedSource {
  readonly locations: ReadonlySet<string>;
  readonly edges: readonly Gen123WorldEdge[];
}

const AUTHORITY_ALIASES: Readonly<Record<string, string>> = {
  "tin-tower": "bell-tower",
  lighthouse: "johto-lighthouse",
  "silver-cave": "mt-silver-cave",
  "fast-ship": "ss-aqua",
  "power-plant": "kanto-power-plant",
  "pokemon-league": "indigo-plateau",
  "s-s-anne": "ss-anne",
  "viapois-chamber": "viapos-chamber",
  "aqua-hideout": "team-aqua-hideout",
  "rocket-hideout": "team-rocket-hq",
};

const SPECIAL_AUTHORITIES = new Set([
  "none",
  "undefined",
  "special-area",
  "dynamic",
  "secret-base",
  "ferry",
]);

function requiredDirectory(source: Gen123WorldSourceKey): string {
  const env = GEN123_WORLD_SOURCES[source].env;
  const value = process.env[env];
  if (value === undefined || value.trim().length === 0)
    throw new Error(`${env} is required for the pinned Gen I-III world topology import`);
  return value;
}

function authorityBase(raw: string): string {
  return raw
    .replace(/^(?:MAPSEC|LANDMARK)_/, "")
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");
}

function routeCandidates(
  routeNo: string,
  source: Gen123WorldSourceKey,
  knownSlugs: ReadonlySet<string>,
): string[] {
  const regions =
    source === "firered"
      ? ["kanto"]
      : source === "emerald"
        ? ["hoenn"]
        : ["johto", "kanto"];
  const candidates: string[] = [];
  for (const region of regions) {
    for (const middle of ["route", "sea-route"] as const) {
      const candidate = `${region}-${middle}-${routeNo}`;
      if (knownSlugs.has(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

function resolveAuthority(
  raw: string,
  source: Gen123WorldSourceKey,
  knownSlugs: ReadonlySet<string>,
): string | null {
  const base = authorityBase(raw);
  if (SPECIAL_AUTHORITIES.has(base)) return null;

  const route = /^route-(\d+)$/.exec(base);
  if (route !== null) {
    const candidates = routeCandidates(route[1] ?? "", source, knownSlugs);
    if (candidates.length === 1) return candidates[0] ?? null;
    if (candidates.length > 1)
      throw new Error(`${source}: ambiguous route authority ${raw}: ${candidates.join(", ")}`);
    return null;
  }

  if (base === "victory-road" || base === "kanto-victory-road") {
    const candidate = source === "firered" ? "kanto-victory-road-2" : "kanto-victory-road-1";
    return knownSlugs.has(candidate) ? candidate : null;
  }

  if (base === "safari-zone") {
    const candidate = source === "emerald" ? "hoenn-safari-zone" : "kanto-safari-zone";
    return knownSlugs.has(candidate) ? candidate : null;
  }

  const alias = AUTHORITY_ALIASES[base];
  if (alias !== undefined && knownSlugs.has(alias)) return alias;
  if (knownSlugs.has(base)) return base;

  const regionPrefixes =
    source === "firered"
      ? ["kanto"]
      : source === "emerald"
        ? ["hoenn"]
        : ["johto", "kanto"];
  const prefixed = regionPrefixes
    .map((region) => `${region}-${base}`)
    .filter((candidate) => knownSlugs.has(candidate));
  if (prefixed.length === 1) return prefixed[0] ?? null;
  if (prefixed.length > 1)
    throw new Error(`${source}: ambiguous authority ${raw}: ${prefixed.join(", ")}`);
  return null;
}

function resolveGbaMap(
  map: GbaMap,
  source: "firered" | "emerald",
  knownSlugs: ReadonlySet<string>,
): string | null {
  if (source === "firered") {
    if (map.name.startsWith("SSAnne_") && knownSlugs.has("ss-anne")) return "ss-anne";
    if (map.name.includes("ViapoisChamber") && knownSlugs.has("viapos-chamber"))
      return "viapos-chamber";
  }
  if (
    source === "emerald" &&
    map.name.startsWith("AquaHideout_") &&
    knownSlugs.has("team-aqua-hideout")
  )
    return "team-aqua-hideout";
  return resolveAuthority(map.region_map_section, source, knownSlugs);
}

function normalizeGbaDirection(direction: GbaDirection): Direction {
  switch (direction) {
    case "up":
      return "north";
    case "down":
      return "south";
    case "left":
      return "west";
    case "right":
      return "east";
    default:
      return direction;
  }
}

async function gbaMaps(directory: string): Promise<GbaMap[]> {
  const mapsDirectory = join(directory, "data", "maps");
  const entries = await readdir(mapsDirectory, { withFileTypes: true });
  const result: GbaMap[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await readFile(join(mapsDirectory, entry.name, "map.json"), "utf8");
      const parsed = JSON.parse(text) as Partial<GbaMap>;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.name === "string" &&
        typeof parsed.region_map_section === "string"
      )
        result.push(parsed as GbaMap);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  return result;
}

function dedupeEdges(edges: readonly Gen123WorldEdge[]): Gen123WorldEdge[] {
  const byKey = new Map<string, Gen123WorldEdge>();
  for (const edge of edges) {
    if (edge.fromSlug === edge.toSlug) continue;
    const key = `${edge.fromSlug}:${edge.toSlug}:${edge.connectionKey}`;
    if (!byKey.has(key)) byKey.set(key, edge);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.fromSlug}:${left.toSlug}:${left.connectionKey}`.localeCompare(
      `${right.fromSlug}:${right.toSlug}:${right.connectionKey}`,
    ),
  );
}

async function parseGba(
  source: "firered" | "emerald",
  directory: string,
  knownSlugs: ReadonlySet<string>,
): Promise<ParsedSource> {
  const maps = await gbaMaps(directory);
  const byId = new Map(maps.map((map) => [map.id, map] as const));
  const locationByMapId = new Map<string, string>();
  for (const map of maps) {
    const slug = resolveGbaMap(map, source, knownSlugs);
    if (slug !== null) locationByMapId.set(map.id, slug);
  }

  const edges: Gen123WorldEdge[] = [];
  for (const map of maps) {
    const fromSlug = locationByMapId.get(map.id);
    if (fromSlug === undefined) continue;
    for (const connection of map.connections ?? []) {
      const toSlug = locationByMapId.get(connection.map);
      if (toSlug === undefined) continue;
      edges.push({
        fromSlug,
        toSlug,
        connectionKey: normalizeGbaDirection(connection.direction),
        source,
      });
    }
    for (const warp of map.warp_events ?? []) {
      if (new Set(["MAP_UNDEFINED", "MAP_DYNAMIC", "MAP_NONE"]).has(warp.dest_map)) continue;
      if (!byId.has(warp.dest_map)) continue;
      const toSlug = locationByMapId.get(warp.dest_map);
      if (toSlug === undefined) continue;
      edges.push({ fromSlug, toSlug, connectionKey: "warp", source });
    }
  }

  return {
    locations: new Set(locationByMapId.values()),
    edges: dedupeEdges(edges),
  };
}

function compactMapName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCrystalMapAuthorities(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("map ")) continue;
    const parts = trimmed
      .slice(4)
      .split(",")
      .map((value) => value.trim());
    const name = parts[0];
    const landmark = parts[3];
    if (name !== undefined && landmark?.startsWith("LANDMARK_") === true)
      result.set(name, landmark);
  }
  return result;
}

function parseCrystalMapConstants(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*map_const\s+([A-Z0-9_]+)/.exec(line);
    const constant = match?.[1];
    if (constant !== undefined) result.set(compactMapName(constant), constant);
  }
  return result;
}

function parseCrystalBorderConnections(
  text: string,
): readonly { fromMap: string; toMap: string; direction: Direction }[] {
  const result: { fromMap: string; toMap: string; direction: Direction }[] = [];
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const attributes = /^map_attributes\s+([A-Za-z0-9]+)/.exec(trimmed);
    if (attributes !== null) {
      current = attributes[1] ?? null;
      continue;
    }
    const connection = /^connection\s+(north|south|west|east),\s*([A-Za-z0-9]+)/.exec(trimmed);
    if (connection !== null && current !== null) {
      result.push({
        fromMap: current,
        toMap: connection[2] ?? "",
        direction: connection[1] as Direction,
      });
    }
  }
  return result;
}

function resolveCrystalMap(
  map: string,
  authority: string,
  knownSlugs: ReadonlySet<string>,
): string | null {
  if (map === "SilverCaveOutside" && knownSlugs.has("mt-silver")) return "mt-silver";
  if (map.startsWith("SilverCave") && knownSlugs.has("mt-silver-cave"))
    return "mt-silver-cave";
  if (map.startsWith("TeamRocketBase") && knownSlugs.has("team-rocket-hq"))
    return "team-rocket-hq";
  return resolveAuthority(authority, "crystal", knownSlugs);
}

async function parseCrystal(
  directory: string,
  knownSlugs: ReadonlySet<string>,
): Promise<ParsedSource> {
  const mapsText = await readFile(join(directory, "data", "maps", "maps.asm"), "utf8");
  const attributesText = await readFile(join(directory, "data", "maps", "attributes.asm"), "utf8");
  const constantsText = await readFile(join(directory, "constants", "map_constants.asm"), "utf8");
  const authorityByMap = parseCrystalMapAuthorities(mapsText);
  const constantsByCompactName = parseCrystalMapConstants(constantsText);
  const mapByConstant = new Map<string, string>();
  for (const map of authorityByMap.keys()) {
    const constant = constantsByCompactName.get(compactMapName(map));
    if (constant !== undefined) mapByConstant.set(constant, map);
  }

  const locationByMap = new Map<string, string>();
  for (const [map, authority] of authorityByMap) {
    const slug = resolveCrystalMap(map, authority, knownSlugs);
    if (slug !== null) locationByMap.set(map, slug);
  }

  const edges: Gen123WorldEdge[] = [];
  for (const connection of parseCrystalBorderConnections(attributesText)) {
    const fromSlug = locationByMap.get(connection.fromMap);
    const toSlug = locationByMap.get(connection.toMap);
    if (fromSlug === undefined || toSlug === undefined) continue;
    edges.push({
      fromSlug,
      toSlug,
      connectionKey: connection.direction,
      source: "crystal",
    });
  }

  const mapFiles = await readdir(join(directory, "maps"), { withFileTypes: true });
  for (const file of mapFiles) {
    if (!file.isFile() || !file.name.endsWith(".asm")) continue;
    const fromMap = basename(file.name, ".asm");
    const fromSlug = locationByMap.get(fromMap);
    if (fromSlug === undefined) continue;
    const text = await readFile(join(directory, "maps", file.name), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("warp_event ")) continue;
      const parts = trimmed
        .slice("warp_event ".length)
        .split(",")
        .map((value) => value.trim());
      const destinationConstant = parts[2];
      if (
        destinationConstant === undefined ||
        new Set(["LAST_MAP", "-1"]).has(destinationConstant)
      )
        continue;
      const toMap = mapByConstant.get(destinationConstant);
      if (toMap === undefined) continue;
      const toSlug = locationByMap.get(toMap);
      if (toSlug === undefined) continue;
      edges.push({ fromSlug, toSlug, connectionKey: "warp", source: "crystal" });
    }
  }

  return {
    locations: new Set(locationByMap.values()),
    edges: dedupeEdges(edges),
  };
}

export async function loadGen123WorldTopology(
  locationRows: readonly CsvRow[],
): Promise<Gen123WorldTopology> {
  const knownSlugs = new Set(locationRows.map((row) => requiredText(row, "identifier")));
  const regionBySlug = new Map(
    locationRows.map(
      (row) => [requiredText(row, "identifier"), requiredInt(row, "region_id")] as const,
    ),
  );

  const [firered, crystal, emerald] = await Promise.all([
    parseGba("firered", requiredDirectory("firered"), knownSlugs),
    parseCrystal(requiredDirectory("crystal"), knownSlugs),
    parseGba("emerald", requiredDirectory("emerald"), knownSlugs),
  ]);

  const fireredKanto = new Set(
    [...firered.locations].filter((slug) => regionBySlug.get(slug) === 1),
  );
  const crystalSupplementEdges = crystal.edges.filter((edge) => {
    const bothKanto = regionBySlug.get(edge.fromSlug) === 1 && regionBySlug.get(edge.toSlug) === 1;
    return !bothKanto || !fireredKanto.has(edge.fromSlug) || !fireredKanto.has(edge.toSlug);
  });

  const allEdges = dedupeEdges([...firered.edges, ...crystalSupplementEdges, ...emerald.edges]);
  const locations = new Set<string>([
    ...firered.locations,
    ...crystal.locations,
    ...emerald.locations,
  ]);

  for (const start of ["pallet-town", "new-bark-town", "littleroot-town"])
    if (!locations.has(start)) throw new Error(`World topology is missing starting area ${start}`);
  if (allEdges.length === 0) throw new Error("World topology produced no cross-area connections");

  const sourceLocationCounts = {
    firered: firered.locations.size,
    crystal: crystal.locations.size,
    emerald: emerald.locations.size,
  } as const;
  const sourceEdgeCounts = {
    firered: allEdges.filter((edge) => edge.source === "firered").length,
    crystal: allEdges.filter((edge) => edge.source === "crystal").length,
    emerald: allEdges.filter((edge) => edge.source === "emerald").length,
  } as const;

  return {
    locationSlugs: locations,
    edges: allEdges,
    sourceLocationCounts,
    sourceEdgeCounts,
  };
}
