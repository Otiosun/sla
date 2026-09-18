import { createHash } from "node:crypto";

export type ZhouliaTimeOfDay = "DAY" | "NIGHT";
export type ZhouliaSurface = "LAND" | "WATER";
export type ZhouliaRarityBand = "COMMON" | "RARE";

export type ZhouliaEncounterCondition =
  | { readonly kind: "TIME_OF_DAY"; readonly value: ZhouliaTimeOfDay }
  | { readonly kind: "SURFACE"; readonly value: ZhouliaSurface }
  | { readonly kind: "RARITY"; readonly value: ZhouliaRarityBand }
  | { readonly kind: "WEATHER"; readonly value: string };

export interface ZhouliaEncounterEntry {
  readonly speciesKey: string;
}

export interface ZhouliaEncounterPool {
  readonly identity: string;
  readonly label: string;
  readonly conditions: readonly ZhouliaEncounterCondition[];
  readonly entries: readonly ZhouliaEncounterEntry[];
}

export interface ZhouliaSite {
  readonly identity: string;
  readonly displayName: string;
  readonly kind:
    | "POKEMON_CENTER"
    | "POKEMART"
    | "MARKET"
    | "FISHING_HOUSE"
    | "MILL"
    | "SHRINE"
    | "COMMUNITY_HOUSE"
    | "DOCKS"
    | "GYM"
    | "SECRET_ARENA"
    | "LANDMARK";
}

export interface ZhouliaNpcRole {
  readonly identity: string;
  readonly roleKey: string;
  readonly displayName: string | null;
  readonly locationIdentity: string;
}

export interface ZhouliaAreaContent {
  readonly identity: string;
  readonly displayName: string;
  readonly regionKey: "zhoulia";
  readonly runtimeKind: "TOWN" | "CITY" | "ROUTE" | "FACILITY" | "OTHER";
  readonly summary: string;
  readonly narrativeKeys: {
    readonly firstArrival?: string;
    readonly returnArrival?: string;
  };
  readonly sites: readonly ZhouliaSite[];
  readonly npcRoles: readonly ZhouliaNpcRole[];
  readonly encounterPools: readonly ZhouliaEncounterPool[];
  readonly editorialNotes: readonly string[];
}

export interface ZhouliaRouteContent {
  readonly identity: string;
  readonly fromAreaIdentity: string;
  readonly toAreaIdentity: string;
  readonly direction: "BIDIRECTIONAL";
}

export interface ZhouliaContentBundle {
  readonly schemaVersion: 1;
  readonly bundleKey: "zhoulia-v1";
  readonly areas: readonly ZhouliaAreaContent[];
  readonly routes: readonly ZhouliaRouteContent[];
}

export interface ZhouliaImportRecord {
  readonly identity: string;
  readonly entityKind: "AREA" | "SITE" | "NPC_ROLE" | "ENCOUNTER_POOL" | "ROUTE";
  readonly payload: unknown;
}

export interface ZhouliaDraftImportPlan {
  readonly bundleKey: "zhoulia-v1";
  readonly fingerprint: string;
  readonly records: readonly ZhouliaImportRecord[];
}

export interface ZhouliaContentDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function species(slug: string): ZhouliaEncounterEntry {
  return { speciesKey: `pokemon.species.${slug}` };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export const VILA_DOS_ARROZAIS: ZhouliaAreaContent = {
  identity: "zhoulia.area.vila-dos-arrozais",
  displayName: "Vila dos Arrozais",
  regionKey: "zhoulia",
  runtimeKind: "TOWN",
  summary:
    "Vila rural cercada por arrozais, cursos d'água e pontos comunitários; funciona como ponto seguro inicial de Zhoulia.",
  narrativeKeys: {
    firstArrival: "zhoulia.vila-dos-arrozais.arrival.first",
    returnArrival: "zhoulia.vila-dos-arrozais.arrival.return",
  },
  sites: [
    {
      identity: "zhoulia.site.vila-dos-arrozais.centro-pokemon",
      displayName: "Centro Pokémon",
      kind: "POKEMON_CENTER",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.pokemart",
      displayName: "PokéMart",
      kind: "POKEMART",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.mercado-de-arroz",
      displayName: "Mercado de Arroz",
      kind: "MARKET",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.casa-de-pesca",
      displayName: "Casa de Pesca",
      kind: "FISHING_HOUSE",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.moinho",
      displayName: "Moinho",
      kind: "MILL",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.santuario-antigo",
      displayName: "Santuário Antigo",
      kind: "SHRINE",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.casa-comunitaria",
      displayName: "Casa Comunitária",
      kind: "COMMUNITY_HOUSE",
    },
    {
      identity: "zhoulia.site.vila-dos-arrozais.docas",
      displayName: "Docas",
      kind: "DOCKS",
    },
  ],
  npcRoles: [
    {
      identity: "zhoulia.npc.nurse-hana",
      roleKey: "NURSE",
      displayName: "Hana",
      locationIdentity: "zhoulia.site.vila-dos-arrozais.centro-pokemon",
    },
    {
      identity: "zhoulia.npc-role.vila-dos-arrozais.xama",
      roleKey: "SHAMAN",
      displayName: null,
      locationIdentity: "zhoulia.site.vila-dos-arrozais.santuario-antigo",
    },
  ],
  encounterPools: [
    {
      identity: "zhoulia.encounter-pool.vila-dos-arrozais.day.land",
      label: "Vila dos Arrozais · Dia",
      conditions: [
        { kind: "TIME_OF_DAY", value: "DAY" },
        { kind: "SURFACE", value: "LAND" },
      ],
      entries: [
        species("bellsprout"),
        species("hoppip"),
        species("sunkern"),
        species("lotad"),
        species("wooper"),
        species("poliwag"),
      ],
    },
    {
      identity: "zhoulia.encounter-pool.vila-dos-arrozais.water",
      label: "Vila dos Arrozais · Água",
      conditions: [{ kind: "SURFACE", value: "WATER" }],
      entries: [
        species("magikarp"),
        species("goldeen"),
        species("psyduck"),
        species("marill"),
        species("tentacool"),
      ],
    },
    {
      identity: "zhoulia.encounter-pool.vila-dos-arrozais.village-rare",
      label: "Vila dos Arrozais · Vila rara",
      conditions: [{ kind: "RARITY", value: "RARE" }],
      entries: [species("meowth"), species("growlithe"), species("pikachu"), species("eevee")],
    },
    {
      identity: "zhoulia.encounter-pool.vila-dos-arrozais.night.land",
      label: "Vila dos Arrozais · Noite",
      conditions: [
        { kind: "TIME_OF_DAY", value: "NIGHT" },
        { kind: "SURFACE", value: "LAND" },
      ],
      entries: [
        species("hoothoot"),
        species("gastly"),
        species("wooper"),
        species("rattata"),
        species("meowth"),
        species("poochyena"),
        species("sentret"),
      ],
    },
  ],
  editorialNotes: [
    "A chegada inicial e o retorno à vila usam chaves narrativas distintas.",
    "Gastly aparece em agrupamento noturno e deve permanecer preservado conforme a fonte editorial; não normalizar encontros entre agrupamentos silenciosamente.",
    "O cooldown especial da primeira chegada é regra de runtime e não deve ser duplicado como conteúdo.",
  ],
};

export const CAMPOS_DE_YUN: ZhouliaAreaContent = {
  identity: "zhoulia.area.campos-de-yun",
  displayName: "Campos de Yun",
  regionKey: "zhoulia",
  runtimeKind: "ROUTE",
  summary:
    "Campos abertos com colinas, trechos de floresta, rios, fazendas, estrada comercial e ruínas.",
  narrativeKeys: {},
  sites: [
    {
      identity: "zhoulia.site.campos-de-yun.ginasio-de-grama",
      displayName: "Ginásio de Grama de Yun",
      kind: "GYM",
    },
    {
      identity: "zhoulia.site.campos-de-yun.o-poco",
      displayName: "O Poço",
      kind: "SECRET_ARENA",
    },
    {
      identity: "zhoulia.site.campos-de-yun.estrada-comercial",
      displayName: "Estrada Comercial",
      kind: "LANDMARK",
    },
    {
      identity: "zhoulia.site.campos-de-yun.ruinas",
      displayName: "Ruínas",
      kind: "LANDMARK",
    },
    {
      identity: "zhoulia.site.campos-de-yun.rios",
      displayName: "Rios de Yun",
      kind: "LANDMARK",
    },
  ],
  npcRoles: [
    {
      identity: "zhoulia.npc-role.campos-de-yun.lider-ginasio-grama",
      roleKey: "GRASS_GYM_LEADER",
      displayName: null,
      locationIdentity: "zhoulia.site.campos-de-yun.ginasio-de-grama",
    },
  ],
  encounterPools: [
    {
      identity: "zhoulia.encounter-pool.campos-de-yun.day.land",
      label: "Campos de Yun · Dia",
      conditions: [
        { kind: "TIME_OF_DAY", value: "DAY" },
        { kind: "SURFACE", value: "LAND" },
      ],
      entries: [
        species("pidgey"),
        species("spearow"),
        species("sentret"),
        species("hoppip"),
        species("oddish"),
        species("bellsprout"),
        species("ponyta"),
        species("nidoran-f"),
        species("nidoran-m"),
      ],
    },
    {
      identity: "zhoulia.encounter-pool.campos-de-yun.rivers",
      label: "Campos de Yun · Rios",
      conditions: [{ kind: "SURFACE", value: "WATER" }],
      entries: [
        species("psyduck"),
        species("poliwag"),
        species("marill"),
        species("lotad"),
        species("magikarp"),
      ],
    },
    {
      identity: "zhoulia.encounter-pool.campos-de-yun.night.land",
      label: "Campos de Yun · Noite",
      conditions: [
        { kind: "TIME_OF_DAY", value: "NIGHT" },
        { kind: "SURFACE", value: "LAND" },
      ],
      entries: [
        species("hoothoot"),
        species("rattata"),
        species("poochyena"),
        species("gastly"),
        species("zubat"),
        species("shuppet"),
        species("marshtomp"),
        species("roselia"),
        species("nuzleaf"),
        species("quagsire"),
        species("gloom"),
      ],
    },
  ],
  editorialNotes: [
    "O líder do Ginásio de Grama não possui nome canônico fornecido; manter apenas o papel.",
    "A Insígnia de Yun pertence ao desenho de progressão futuro; não criar gate de ginásio nesta etapa.",
    "A fonte editorial de Yun não forneceu uma lista separada para o cabeçalho de localização; não fabricar uma.",
    "O Poço é uma arena subterrânea secreta e não deve ser promovida a ginásio.",
  ],
};

export const FLORESTA_DE_SEKIGLOOM_MIL_BAMBU: ZhouliaAreaContent = {
  identity: "zhoulia.area.floresta-de-sekigloom-mil-bambu",
  displayName: "Floresta de Sekigloom / Mil Bambu",
  regionKey: "zhoulia",
  runtimeKind: "ROUTE",
  summary:
    "Floresta de bambu coberta por névoa, associada a clãs e ninjas, com referências narrativas noturnas e espectrais.",
  narrativeKeys: {},
  sites: [
    {
      identity: "zhoulia.site.floresta-de-sekigloom-mil-bambu.santuario-sekizor",
      displayName: "Santuário Sekizor",
      kind: "SHRINE",
    },
  ],
  npcRoles: [],
  encounterPools: [],
  editorialNotes: [
    "A fonte usa Floresta de Sekigloom, Santuário Sekizor e Mil Bambu; preservar a inconsistência de nomenclatura e não normalizar silenciosamente.",
    "A fonte faz referências a noite e a locais ou águas de caráter espectral, mas não fornece neste material uma lista de espécies suficiente para materializar pools mecânicos.",
    "Nenhuma faixa horária numérica foi fornecida para noite.",
  ],
};

export const CIDADE_DO_AQUARIO: ZhouliaAreaContent = {
  identity: "zhoulia.area.cidade-do-aquario",
  displayName: "Cidade do Aquário",
  regionKey: "zhoulia",
  runtimeKind: "CITY",
  summary:
    "Cidade costeira vertical ligada à água, ao mar profundo e a espaços urbanos e submersos.",
  narrativeKeys: {},
  sites: [
    {
      identity: "zhoulia.site.cidade-do-aquario.ginasio-das-mares",
      displayName: "Ginásio das Marés",
      kind: "GYM",
    },
  ],
  npcRoles: [],
  encounterPools: [],
  editorialNotes: [
    "A fonte menciona agrupamentos de encontro urbanos, de água, submersos e raros, mas não fornece aqui espécies suficientes para materializar tabelas sem invenção.",
    "Nenhum nome canônico de líder do Ginásio das Marés foi fornecido neste material; não criar NPC nomeado.",
  ],
};

export const PORTO_DOS_CEUS: ZhouliaAreaContent = {
  identity: "zhoulia.area.porto-dos-ceus",
  displayName: "Porto dos Céus",
  regionKey: "zhoulia",
  runtimeKind: "OTHER",
  summary: "Área de baía, montanhas e ilhas com forte identidade ligada a Pokémon do tipo Voador.",
  narrativeKeys: {},
  sites: [],
  npcRoles: [],
  encounterPools: [],
  editorialNotes: [
    "A fonte fornecida não define um ginásio para Porto dos Céus; não adicionar um.",
    "A fonte não fornece neste material lista de espécies, pools ou conexões de rota suficientes para materialização mecânica.",
  ],
};

export const TEMPLO_DO_CEU_ANTIGO: ZhouliaAreaContent = {
  identity: "zhoulia.area.templo-do-ceu-antigo",
  displayName: "Templo do Céu Antigo",
  regionKey: "zhoulia",
  runtimeKind: "OTHER",
  summary: "Área montanhosa ligada a um antigo pacto com dragões e a um mistério celeste.",
  narrativeKeys: {},
  sites: [],
  npcRoles: [],
  encounterPools: [],
  editorialNotes: [
    "A fonte cita Dragonite, Salamence, Flygon e Altaria associados ao local; preservar a citação sem fabricar pesos, níveis ou uma tabela de encontro.",
    "A serpente celeste é descrita apenas como semelhante a Rayquaza e deve permanecer um mistério; não identificar a criatura como Rayquaza.",
    "Nenhuma rota, NPC nomeado ou faixa horária numérica adicional foi fornecida neste material.",
  ],
};

export const ZHOULIA_TYPED_CONTENT_V1: ZhouliaContentBundle = {
  schemaVersion: 1,
  bundleKey: "zhoulia-v1",
  areas: [
    VILA_DOS_ARROZAIS,
    CAMPOS_DE_YUN,
    FLORESTA_DE_SEKIGLOOM_MIL_BAMBU,
    CIDADE_DO_AQUARIO,
    PORTO_DOS_CEUS,
    TEMPLO_DO_CEU_ANTIGO,
  ],
  routes: [
    {
      identity: "zhoulia.route.vila-dos-arrozais.campos-de-yun",
      fromAreaIdentity: VILA_DOS_ARROZAIS.identity,
      toAreaIdentity: CAMPOS_DE_YUN.identity,
      direction: "BIDIRECTIONAL",
    },
  ],
};

export function validateZhouliaContentBundle(bundle: ZhouliaContentBundle): void {
  if (bundle.schemaVersion !== 1) throw new Error("Unsupported Zhoulia content schema");
  if (bundle.bundleKey !== "zhoulia-v1") throw new Error("Unexpected Zhoulia bundle key");
  if (bundle.areas.length === 0) throw new Error("Zhoulia bundle must contain areas");

  const areaIds = bundle.areas.map((area) => area.identity);
  assertUnique(areaIds, "area identity");

  const allIdentities: string[] = [...areaIds, ...bundle.routes.map((route) => route.identity)];

  for (const area of bundle.areas) {
    assertUnique(
      area.sites.map((site) => site.identity),
      `site identity in ${area.identity}`,
    );
    assertUnique(
      area.npcRoles.map((npc) => npc.identity),
      `NPC role identity in ${area.identity}`,
    );
    assertUnique(
      area.encounterPools.map((pool) => pool.identity),
      `encounter pool identity in ${area.identity}`,
    );

    allIdentities.push(...area.sites.map((site) => site.identity));
    allIdentities.push(...area.npcRoles.map((npc) => npc.identity));
    allIdentities.push(...area.encounterPools.map((pool) => pool.identity));

    const siteIds = new Set(area.sites.map((site) => site.identity));
    for (const npc of area.npcRoles) {
      if (!siteIds.has(npc.locationIdentity)) {
        throw new Error(`NPC role ${npc.identity} points to missing site ${npc.locationIdentity}`);
      }
    }

    for (const pool of area.encounterPools) {
      if (pool.entries.length === 0) throw new Error(`Encounter pool ${pool.identity} is empty`);
      assertUnique(
        pool.entries.map((entry) => entry.speciesKey),
        `species within ${pool.identity}`,
      );
      for (const entry of pool.entries) {
        if (!entry.speciesKey.startsWith("pokemon.species.")) {
          throw new Error(`Unstable species identity: ${entry.speciesKey}`);
        }
      }
    }
  }

  assertUnique(allIdentities, "global content identity");

  for (const identity of allIdentities) {
    if (uuidLike.test(identity)) {
      throw new Error(`Hard-wired UUID is not allowed as content identity: ${identity}`);
    }
  }

  const validAreas = new Set(areaIds);
  for (const route of bundle.routes) {
    if (!validAreas.has(route.fromAreaIdentity) || !validAreas.has(route.toAreaIdentity)) {
      throw new Error(`Route ${route.identity} references missing area`);
    }
    if (route.fromAreaIdentity === route.toAreaIdentity) {
      throw new Error(`Route ${route.identity} cannot connect an area to itself`);
    }
  }

  const yun = bundle.areas.find((area) => area.identity === CAMPOS_DE_YUN.identity);
  const leader = yun?.npcRoles.find((npc) => npc.roleKey === "GRASS_GYM_LEADER");
  if (leader?.displayName !== null) {
    throw new Error(
      "Yun Grass Gym leader must remain unnamed until canonical content supplies a name",
    );
  }
}

export function zhouliaContentFingerprint(bundle: ZhouliaContentBundle): string {
  validateZhouliaContentBundle(bundle);
  return createHash("sha256").update(stableJson(bundle)).digest("hex");
}

export function flattenZhouliaContent(
  bundle: ZhouliaContentBundle,
): readonly ZhouliaImportRecord[] {
  validateZhouliaContentBundle(bundle);

  const records: ZhouliaImportRecord[] = [];
  for (const area of bundle.areas) {
    records.push({ identity: area.identity, entityKind: "AREA", payload: area });
    for (const site of area.sites) {
      records.push({ identity: site.identity, entityKind: "SITE", payload: site });
    }
    for (const npc of area.npcRoles) {
      records.push({ identity: npc.identity, entityKind: "NPC_ROLE", payload: npc });
    }
    for (const pool of area.encounterPools) {
      records.push({ identity: pool.identity, entityKind: "ENCOUNTER_POOL", payload: pool });
    }
  }
  for (const route of bundle.routes) {
    records.push({ identity: route.identity, entityKind: "ROUTE", payload: route });
  }

  return records.sort((left, right) => left.identity.localeCompare(right.identity));
}

export function buildZhouliaDraftImportPlan(input: {
  readonly releaseStatus: "DRAFT" | "VALIDATED" | "PUBLISHED";
  readonly bundle?: ZhouliaContentBundle;
}): ZhouliaDraftImportPlan {
  if (input.releaseStatus !== "DRAFT") {
    throw new Error("Zhoulia content may only be imported into a DRAFT content release");
  }
  const bundle = input.bundle ?? ZHOULIA_TYPED_CONTENT_V1;
  return {
    bundleKey: bundle.bundleKey,
    fingerprint: zhouliaContentFingerprint(bundle),
    records: flattenZhouliaContent(bundle),
  };
}

export function diffZhouliaContent(
  previous: ZhouliaContentBundle,
  next: ZhouliaContentBundle,
): ZhouliaContentDiff {
  const before = new Map(
    flattenZhouliaContent(previous).map((record) => [record.identity, stableJson(record)]),
  );
  const after = new Map(
    flattenZhouliaContent(next).map((record) => [record.identity, stableJson(record)]),
  );

  const added = [...after.keys()].filter((identity) => !before.has(identity)).sort();
  const removed = [...before.keys()].filter((identity) => !after.has(identity)).sort();
  const changed = [...after.keys()]
    .filter((identity) => before.has(identity) && before.get(identity) !== after.get(identity))
    .sort();

  return { added, removed, changed };
}

validateZhouliaContentBundle(ZHOULIA_TYPED_CONTENT_V1);
