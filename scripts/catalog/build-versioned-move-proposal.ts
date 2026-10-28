import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseVersionedAcquisitionLearnset,
  type VersionedAcquisitionMove,
} from "../../src/modules/catalog/versioned-learnset-source.js";
import {
  classifyMoveForBattleReview,
  type ExternalMoveMechanics,
} from "../../src/modules/catalog/move-mechanics-review.js";
import {
  parseVersionedEvolutionChain,
  type ExternalEvolutionChain,
} from "../../src/modules/catalog/versioned-evolution-chain.js";

/**
 * Offline-at-runtime content builder. Run only in content preparation; never
 * from WhatsApp/Hub or against production DB.
 *
 * Usage:
 *  node --import tsx scripts/catalog/build-versioned-move-proposal.ts
 *     ./docs/catalog/pokemon-beyond-move-sources.json ./build/catalog/move-proposal.json
 *
 * Pins source version and embeds exact raw source hashes. It does not publish
 * releases, grant moves, or change players.
 */
interface SourceManifest {
  readonly versionGroup: string;
  readonly pokemonSlugs: readonly string[];
  readonly explicitlyApprovedVersionOverrides?: Readonly<Record<string, string>>;
}

type Named = { name: string; url?: string };
type MachineInfo = {
  readonly move: Named;
  readonly item: Named;
  readonly version_group: Named;
};
type MoveMachineRef = { machine: { url: string }; version_group: Named };
type MoveResponse = { name: string; machines: readonly MoveMachineRef[] };

const inputFile = process.argv[2] ?? "";
const outputFile = process.argv[3] ?? "";
if (!inputFile || !outputFile || inputFile === outputFile) {
  throw new Error("Provide different input manifest and output proposal paths");
}
const manifest = JSON.parse(await readFile(inputFile, "utf8")) as SourceManifest;
const validSlug = /^[a-z0-9][a-z0-9-]*$/u;
if (!validSlug.test(manifest.versionGroup) || !Array.isArray(manifest.pokemonSlugs) ||
    manifest.pokemonSlugs.length === 0 || manifest.pokemonSlugs.some((x) => !validSlug.test(x))) {
  throw new Error("A nonempty, explicit versioned Pokémon slug manifest is mandatory");
}
if (new Set(manifest.pokemonSlugs).size !== manifest.pokemonSlugs.length) {
  throw new Error("Duplicate form slugs in content manifest");
}
const supportedOverrides = manifest.explicitlyApprovedVersionOverrides ?? {};
for (const [pokemon, version] of Object.entries(supportedOverrides)) {
  if (!manifest.pokemonSlugs.includes(pokemon) || !validSlug.test(version)) {
    throw new Error("Override requires an existing Pokémon and explicit version-group");
  }
}
const cache = new Map<string, Promise<{value: unknown; sha256: string}>>();
const MAX_CONCURRENT_REQUESTS = 5;
let activeRequests = 0;
const waiting: Array<() => void> = [];
async function reserveRequest(): Promise<void> {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeRequests += 1;
}
function finishRequest(): void {
  activeRequests -= 1;
  waiting.shift()?.();
}
async function loadSource(url: string): Promise<{value: unknown; sha256: string}> {
  await reserveRequest();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "pokemon-beyond-content-proposal/1", Accept: "application/json" },
          signal: AbortSignal.timeout(18_000),
        });
        if (response.ok) {
          const raw = await response.text();
          return { value: JSON.parse(raw) as unknown,
            sha256: createHash("sha256").update(raw).digest("hex") };
        }
        if (![429,500,502,503,504].includes(response.status)) {
          throw new Error(`Source request failed ${response.status}: ${url}`);
        }
        if (attempt === 3) throw new Error(`Source unavailable ${response.status}: ${url}`);
      } catch (error) {
        if (attempt === 3 || (error instanceof Error && error.message.startsWith("Source request failed"))) {
          throw error;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
    throw new Error(`Source unavailable: ${url}`);
  } finally {
    finishRequest();
  }
}
async function fetchJson<T>(url: string): Promise<{data: T; sha256: string}> {
  if (!/^https:\/\/pokeapi\.co\/api\/v2\/[a-z0-9/._-]+\/?$/u.test(url)) {
    throw new Error("Unexpected source host or path");
  }
  let result = cache.get(url);
  if (result === undefined) {
    result = loadSource(url);
    cache.set(url, result);
  }
  const saved = await result;
  return { data: saved.value as T, sha256: saved.sha256 };
}
// Resolve actual numeric generation IDs instead of guessing historical order.
const pinnedGroupIds = new Map<string, number>();
await Promise.all([...new Set([manifest.versionGroup,...Object.values(supportedOverrides)])]
  .map(async (slug) => {
    const result = await fetchJson<{id:number;name:string}>(
      `https://pokeapi.co/api/v2/version-group/${slug}/`,
    );
    if (result.data.name !== slug || !Number.isInteger(result.data.id) || result.data.id<1) {
      throw new Error(`Unverified version-group identity: ${slug}`);
    }
    pinnedGroupIds.set(slug,result.data.id);
  }));

const pokemon: Array<{
  pokemonSlug: string;
  versionGroup: string;
  rawSha256: string;
  moves: readonly VersionedAcquisitionMove[];
}> = [];
const machineMap = new Map<string, { itemSlug: string; moveSlug: string; versionGroup: string; sha256: string }>();

const generatedPokemon = await Promise.all(manifest.pokemonSlugs.map(async (slug) => {
  const version = supportedOverrides[slug] ?? manifest.versionGroup;
  const source = await fetchJson<unknown>(`https://pokeapi.co/api/v2/pokemon/${slug}/`);
  const parsed = parseVersionedAcquisitionLearnset(source.data, version);
  await Promise.all(parsed.moves.filter((move) => move.method === "MACHINE").map(async (entry) => {
    const move = await fetchJson<MoveResponse>(`https://pokeapi.co/api/v2/move/${entry.moveSlug}/`);
    const matching = move.data.machines.filter((ref) => ref.version_group.name === version);
    if (matching.length === 0) {
      throw new Error(`No machine mapping for ${slug}:${entry.moveSlug}:${version}`);
    }
    await Promise.all(matching.map(async (ref) => {
      const machine = await fetchJson<MachineInfo>(ref.machine.url);
      if (machine.data.move.name !== entry.moveSlug ||
          machine.data.version_group.name !== version ||
          !validSlug.test(machine.data.item.name)) {
        throw new Error(`Unverified machine mapping ${entry.moveSlug}:${version}`);
      }
      const key = `${version}:${entry.moveSlug}:${machine.data.item.name}`;
      machineMap.set(key,{ itemSlug:machine.data.item.name, moveSlug:entry.moveSlug,
        versionGroup:version, sha256:machine.sha256 });
    }));
  }));
  return { pokemonSlug:slug, versionGroup:version,rawSha256:source.sha256,moves:parsed.moves };
}));
pokemon.push(...generatedPokemon);

// Include validated, hashed damage parameters but never auto-publish effects.
const allMoveSlugs = [...new Set(pokemon.flatMap((entry) =>
  entry.moves.map((move) => move.moveSlug)))].sort();
const moveDefinitions = await Promise.all(allMoveSlugs.map(async (slug) => {
  const source = await fetchJson<MoveResponse & ExternalMoveMechanics>(
    `https://pokeapi.co/api/v2/move/${slug}/`,
  );
  if (source.data.name !== slug) throw new Error(`Move identity mismatch for ${slug}`);
  return { ...classifyMoveForBattleReview(source.data), rawSha256: source.sha256 };
}));

// Source families are fetched once, even when several active Pokémon share
// the same evolution chain. No ITEM, friendship or branching rule is published.
const sourceChains = new Map<number,{
  chainId:number;
  rawSha256:string;
  rootSpeciesSlug:string;
  edges:ReturnType<typeof parseVersionedEvolutionChain>;
}>();
await Promise.all(manifest.pokemonSlugs.map(async (slug) => {
  const species = await fetchJson<{
    name:string; evolution_chain:{url:string}|null;
  }>(`https://pokeapi.co/api/v2/pokemon-species/${slug}/`);
  if (species.data.name !== slug || species.data.evolution_chain === null) {
    throw new Error(`Evolution chain not available for ${slug}`);
  }
  const chain = await fetchJson<ExternalEvolutionChain>(species.data.evolution_chain.url);
  const pinnedVersion = supportedOverrides[slug] ?? manifest.versionGroup;
  const pinnedId = pinnedGroupIds.get(pinnedVersion);
  if (pinnedId === undefined) throw new Error(`Version group not pinned: ${pinnedVersion}`);
  const edges = parseVersionedEvolutionChain(chain.data, {maxVersionGroupId:pinnedId});
  const existing = sourceChains.get(chain.data.id);
  if (existing !== undefined && existing.rawSha256 !== chain.sha256) {
    throw new Error(`Two conflicting sources for evolution chain ${chain.data.id}`);
  }
  sourceChains.set(chain.data.id,{
    chainId:chain.data.id,rawSha256:chain.sha256,
    rootSpeciesSlug:chain.data.chain.species.name,
    edges,
  });
}));
const evolutionChains = [...sourceChains.values()].sort((a,b)=>a.chainId-b.chainId);

const proposal = {
  format: "POKEMON_BEYOND_MOVE_PROPOSAL_V1",
  generatedAt: new Date().toISOString(),
  source: "https://pokeapi.co/api/v2/",
  defaultVersionGroup: manifest.versionGroup,
  pokemon,
  moveDefinitions,
  evolutionChains,
  machines: [...machineMap.values()].sort((a, b) =>
    a.itemSlug.localeCompare(b.itemSlug) || a.moveSlug.localeCompare(b.moveSlug)),
  constraints: [
    "Only LEVEL grants XP milestone moves",
    "EVOLUTION grants only when evolving",
    "MACHINE must match a version-pinned item and form compatibility",
    "TUTOR and EGG require their own approved rules; never auto-grant",
    "New content releases require coverage validation and human diff approval",
  ],
};
await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(proposal, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  event: "stage2.versioned-move-proposal",
  forms: pokemon.length,
  machines: proposal.machines.length,
  moveDefinitions: proposal.moveDefinitions.length,
  basicDamageCandidates: proposal.moveDefinitions.filter((move) => move.basicDamageCandidate).length,
  effectsRequiringReview: proposal.moveDefinitions.filter((move) => !move.basicDamageCandidate).length,
  evolutionChains: proposal.evolutionChains.length,
  evolutionEdges: proposal.evolutionChains.reduce((count,chain)=>count+chain.edges.length,0),
  outputFile,
  writesToDatabase: false,
}));
