import { randomUUID } from "node:crypto";
import type { RandomSource } from "../../platform/rng/index.js";
import { ok, type Result } from "../../shared-kernel/result.js";
import type { CommunityChatContext } from "../community/contracts.js";
import type { WildPokemonBuild } from "../encounter/contracts.js";
import { generateWildPokemon } from "../encounter/generation.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import {
  type CompetitiveSpawnActivityRepository,
  competitiveActivityBaseWeightMilli,
  competitiveActivityFingerprint,
} from "./activity.js";
import type {
  CompetitiveSpawnCandidate,
  CompetitiveSpawnRenderSpec,
  CompetitiveSpawnRepository,
} from "./contracts.js";
import { competitiveSpawnTimeBucket, normalizeCompetitiveSpawnGuess } from "./normalization.js";
import {
  type CompetitiveSpawnSettingsRepository,
  parseCompetitiveSpawnAdminAction,
} from "./settings.js";

export const COMPETITIVE_SPAWN_COOLDOWN_MS = 7 * 60_000;
export const COMPETITIVE_SPAWN_TTL_MS = 5 * 60_000;
export const COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT = 35;
export const COMPETITIVE_SPAWN_GUESS_MIN_INTERVAL_MS = 1_200;
export const COMPETITIVE_SPAWN_GUESS_MAX_PER_PLAYER = 50;
export const COMPETITIVE_SPAWN_PUBLICATION_ORPHAN_GRACE_MS = 2 * 60_000;

export const COMPETITIVE_SPAWN_BACKGROUND_REVISION = "5efaff824d4255e347da71f4a175239a3f8c3874";

export const COMPETITIVE_SPAWN_BACKGROUND_URLS = [
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/1.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/2.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/3.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/4.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/5.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/6.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/7.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/8.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/9.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/10.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/11.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/12.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/13.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/14.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/15.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/16.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/17.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/18.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/19.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/20.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/21.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/22.png`,
  `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/23.png`,
] as const;

export type CompetitiveSpawnBackgroundContext =
  | "NEUTRAL"
  | "RUGGED"
  | "SNOW"
  | "WATER"
  | "SKY"
  | "COSMIC";

export const COMPETITIVE_SPAWN_BACKGROUND_GROUPS = {
  NEUTRAL: [1, 3, 4],
  RUGGED: [2, 5, 6, 8, 11, 18, 20],
  SNOW: [7, 10, 13, 17, 22, 23],
  WATER: [14, 15, 19],
  SKY: [9, 12, 16],
  COSMIC: [21],
} as const satisfies Record<CompetitiveSpawnBackgroundContext, readonly number[]>;

const COMPETITIVE_SPAWN_SAFE_ZONE = {
  minCenterX: 382,
  maxCenterX: 418,
  groundY: 438,
} as const;

export function competitiveSpawnBackgroundUrlFor(input: {
  readonly rng: { randomInt(maxExclusive: number): number };
  readonly context?: CompetitiveSpawnBackgroundContext;
}): string {
  const context = input.context ?? "NEUTRAL";
  const backgroundIds = COMPETITIVE_SPAWN_BACKGROUND_GROUPS[context];
  const selectedId = backgroundIds[input.rng.randomInt(backgroundIds.length)];
  if (selectedId === undefined) {
    throw new Error("Competitive spawn background group selection did not resolve");
  }
  const backgroundUrl = COMPETITIVE_SPAWN_BACKGROUND_URLS[selectedId - 1];
  if (backgroundUrl === undefined) {
    throw new Error("Competitive spawn background URL did not resolve");
  }
  return backgroundUrl;
}

export function competitiveSpawnBackgroundContextForTypes(
  type1Slug: string | undefined,
  type2Slug: string | null | undefined,
): CompetitiveSpawnBackgroundContext {
  const types = new Set(
    [type1Slug, type2Slug]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.toLocaleLowerCase("en-US")),
  );

  if (types.has("water")) return "WATER";
  if (types.has("ice")) return "SNOW";
  if (types.has("flying")) return "SKY";
  if (
    types.has("rock") ||
    types.has("ground") ||
    types.has("fire") ||
    types.has("steel") ||
    types.has("ghost") ||
    types.has("dark")
  ) {
    return "RUGGED";
  }
  return "NEUTRAL";
}
const COMPETITIVE_SPAWN_COSMIC_SPECIES = new Set(["deoxys", "rayquaza"] as const);
const COMPETITIVE_SPAWN_SKY_SPECIES = new Set(["pelipper", "wingull"] as const);
const COMPETITIVE_SPAWN_WATER_SPECIES = new Set(["gyarados", "mantine"] as const);

export function competitiveSpawnBackgroundContextForSpeciesAndTypes(
  speciesSlug: string | undefined,
  type1Slug: string | undefined,
  type2Slug: string | null | undefined,
): CompetitiveSpawnBackgroundContext {
  const normalizedSpecies =
    typeof speciesSlug === "string" ? speciesSlug.toLocaleLowerCase("en-US") : "";
  if (COMPETITIVE_SPAWN_COSMIC_SPECIES.has(normalizedSpecies as "deoxys" | "rayquaza")) {
    return "COSMIC";
  }
  if (COMPETITIVE_SPAWN_SKY_SPECIES.has(normalizedSpecies as "pelipper" | "wingull")) {
    return "SKY";
  }
  if (COMPETITIVE_SPAWN_WATER_SPECIES.has(normalizedSpecies as "gyarados" | "mantine")) {
    return "WATER";
  }
  return competitiveSpawnBackgroundContextForTypes(type1Slug, type2Slug);
}
export function competitiveSpawnCenterX(input: {
  readonly rng: { randomInt(maxExclusive: number): number };
}): number {
  return (
    COMPETITIVE_SPAWN_SAFE_ZONE.minCenterX +
    input.rng.randomInt(
      COMPETITIVE_SPAWN_SAFE_ZONE.maxCenterX - COMPETITIVE_SPAWN_SAFE_ZONE.minCenterX + 1,
    )
  );
}

export function competitiveSpawnArtworkUrl(nationalDex: number, shiny: boolean): string {
  if (!Number.isSafeInteger(nationalDex) || nationalDex <= 0) {
    throw new RangeError("Competitive spawn National Dex id must be a positive integer");
  }
  const base = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other";
  const artworkPath = shiny
    ? `official-artwork/shiny/${nationalDex}.png`
    : `official-artwork/${nationalDex}.png`;
  return `${base}/${artworkPath}`;
}

interface CommunityPort {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<CommunityChatContext>;
}

interface BuildPort {
  wildBuild(contentReleaseId: string, formId: string): Promise<WildPokemonBuild | null>;
}

interface CompetitiveSpawnDependencies {
  readonly repository: CompetitiveSpawnRepository;
  readonly activity: CompetitiveSpawnActivityRepository;
  readonly settings: CompetitiveSpawnSettingsRepository;
  readonly community: CommunityPort;
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly builds: BuildPort;
  readonly rng: RandomSource;
  readonly now?: () => Date;
}

function emptyResult(refId: string | null = null): MessageHandlerResult {
  return {
    resultRefType: refId === null ? null : "COMPETITIVE_SPAWN",
    resultRefId: refId,
    outgoing: [],
  };
}

function isGameGroup(
  group: CommunityChatContext,
): group is CommunityChatContext & { groupId: string } {
  return (
    group.known &&
    group.groupId !== null &&
    group.role === "GAME" &&
    (group.capabilities.includes("pve") || group.capabilities.includes("world"))
  );
}

function chooseWeighted(
  candidates: readonly CompetitiveSpawnCandidate[],
  rng: RandomSource,
): CompetitiveSpawnCandidate {
  let total = 0;
  for (const candidate of candidates) {
    total += candidate.weight;
    if (!Number.isSafeInteger(total)) throw new Error("Competitive spawn weight total is unsafe");
  }
  if (total <= 0) throw new Error("Competitive spawn candidate pool is empty");
  const roll = rng.randomInt(total);
  let cursor = 0;
  for (const candidate of candidates) {
    cursor += candidate.weight;
    if (roll < cursor) return candidate;
  }
  throw new Error("Competitive spawn weighted selection did not resolve");
}

function levelFor(candidate: CompetitiveSpawnCandidate, rng: RandomSource): number {
  const min = Math.max(1, Math.min(100, candidate.minLevel));
  const max = Math.max(min, Math.min(100, candidate.maxLevel));
  return min + rng.randomInt(max - min + 1);
}

function renderProfile(
  nationalDex: number,
  shiny: boolean,
  backgroundContext: CompetitiveSpawnBackgroundContext,
  occurredAt: string,
  rng: RandomSource,
): CompetitiveSpawnRenderSpec {
  const override = new Map<
    number,
    { readonly maxSize: number; readonly floatY: number; readonly shadowOpacity: number }
  >([
    [6, { maxSize: 360, floatY: 18, shadowOpacity: 0.22 }],
    [25, { maxSize: 320, floatY: 0, shadowOpacity: 0.27 }],
    [50, { maxSize: 300, floatY: 0, shadowOpacity: 0.25 }],
    [142, { maxSize: 370, floatY: 48, shadowOpacity: 0.15 }],
    [252, { maxSize: 315, floatY: 0, shadowOpacity: 0.26 }],
    [321, { maxSize: 395, floatY: 0, shadowOpacity: 0.24 }],
    [384, { maxSize: 390, floatY: 70, shadowOpacity: 0.12 }],
  ]).get(nationalDex);
  const profile = override ?? { maxSize: 345, floatY: 0, shadowOpacity: 0.24 };
  const artworkUrl = competitiveSpawnArtworkUrl(nationalDex, shiny);
  const backgroundUrl = competitiveSpawnBackgroundUrlFor({
    rng,
    context: backgroundContext,
  });

  return {
    schemaVersion: 1,
    backgroundUrl,
    spriteUrl: artworkUrl,
    fallbackSpriteUrl: artworkUrl,
    centerX: competitiveSpawnCenterX({ rng }),
    groundY: COMPETITIVE_SPAWN_SAFE_ZONE.groundY,
    maxSize: profile.maxSize,
    floatY: profile.floatY,
    shadowOpacity: profile.shadowOpacity,
    timeBucket: competitiveSpawnTimeBucket(occurredAt),
  };
}

function answerAliases(candidate: CompetitiveSpawnCandidate): readonly string[] {
  return [
    normalizeCompetitiveSpawnGuess(candidate.displayName),
    normalizeCompetitiveSpawnGuess(candidate.speciesSlug),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

export class CompetitiveSpawnService {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: CompetitiveSpawnDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async observeActivity(message: IncomingMessage): Promise<void> {
    const baseWeightMilli = competitiveActivityBaseWeightMilli(message);
    if (baseWeightMilli <= 0) return;

    const group = await this.dependencies.community.resolveChat({
      provider: message.provider,
      chatRef: message.chatRef,
    });
    if (!isGameGroup(group)) return;
    if (!(await this.dependencies.settings.isEnabled(group.groupId))) return;

    const now = this.now();
    const incenseUntil =
      this.dependencies.settings.incenseUntil === undefined
        ? null
        : await this.dependencies.settings.incenseUntil(group.groupId, now);

    const player = await this.dependencies.players.resolvePlayer({
      provider: message.provider,
      externalId: message.senderRef,
    });
    if (!player.ok) return;

    await this.dependencies.activity.observe({
      communityGroupId: group.groupId,
      provider: message.provider,
      externalMessageId: message.externalMessageId,
      playerId: player.value.playerId,
      senderRef: message.senderRef,
      fingerprint: competitiveActivityFingerprint(message),
      baseWeightMilli,
      targetRoll: this.dependencies.rng.randomInt(10_000),
      incenseActive: incenseUntil !== null,
      now,
      cooldownMs: COMPETITIVE_SPAWN_COOLDOWN_MS,
    });
  }

  public async admits(message: IncomingMessage): Promise<boolean> {
    const group = await this.dependencies.community.resolveChat({
      provider: message.provider,
      chatRef: message.chatRef,
    });
    if (!isGameGroup(group)) return false;
    if (!(await this.dependencies.settings.isEnabled(group.groupId))) return false;

    const active = await this.dependencies.repository.activeForGroup(group.groupId);
    if (active !== null) return false;

    const now = this.now();
    const activity = await this.dependencies.activity.stateForGroup(group.groupId, now);
    if (activity.targetMilli === null || activity.progressMilli < activity.targetMilli)
      return false;

    return this.dependencies.repository.canOpen(group.groupId, now, COMPETITIVE_SPAWN_COOLDOWN_MS);
  }

  public async resolve(
    context: MessageHandlerContext,
    options: { readonly bypassActivity?: boolean } = {},
  ): Promise<Result<MessageHandlerResult | null>> {
    const group = await this.dependencies.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!isGameGroup(group)) return ok(null);
    if (!(await this.dependencies.settings.isEnabled(group.groupId))) return ok(null);

    const now = this.now();
    const active = await this.dependencies.repository.activeForGroup(group.groupId);
    if (active !== null) return ok(null);

    if (options.bypassActivity !== true) {
      const activity = await this.dependencies.activity.stateForGroup(group.groupId, now);
      if (activity.targetMilli === null || activity.progressMilli < activity.targetMilli) {
        return ok(null);
      }
    }
    if (
      !(await this.dependencies.repository.canOpen(
        group.groupId,
        now,
        COMPETITIVE_SPAWN_COOLDOWN_MS,
      ))
    ) {
      return ok(null);
    }

    const sender = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const playerId = sender.ok ? sender.value.playerId : null;
    const candidateContext = await this.dependencies.repository.candidateContext(playerId);
    if (candidateContext === null || candidateContext.globalCandidates.length === 0)
      return ok(null);

    const useLocal =
      candidateContext.localCandidates.length > 0 &&
      this.dependencies.rng.randomInt(100) < COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT;
    const pool = useLocal ? candidateContext.localCandidates : candidateContext.globalCandidates;
    const candidate = chooseWeighted(pool, this.dependencies.rng);
    const build = await this.dependencies.builds.wildBuild(
      candidateContext.contentReleaseId,
      candidate.formId,
    );
    if (build === null) return ok(null);

    const level = levelFor(candidate, this.dependencies.rng);
    const shiny = this.dependencies.rng.randomInt(4096) === 0;
    const snapshot = generateWildPokemon(build, level, this.dependencies.rng, { shiny });
    const renderSpec = renderProfile(
      candidate.nationalDex,
      shiny,
      competitiveSpawnBackgroundContextForSpeciesAndTypes(
        candidate.speciesSlug,
        candidate.type1Slug,
        candidate.type2Slug,
      ),
      context.message.occurredAt,
      this.dependencies.rng,
    );
    const spawnId = randomUUID();

    const created = await this.dependencies.repository.createOpen(
      {
        id: spawnId,
        communityGroupId: group.groupId,
        provider: context.message.provider,
        chatRef: context.message.chatRef,
        contentReleaseId: candidateContext.contentReleaseId,
        rulesetId: candidateContext.rulesetId,
        areaId: candidate.areaId,
        formId: candidate.formId,
        speciesId: candidate.speciesId,
        speciesDisplayName: candidate.displayName,
        normalizedAnswers: answerAliases(candidate),
        nationalDex: candidate.nationalDex,
        level,
        shiny,
        snapshot,
        renderSpec,
        creationIdempotencyKey: `${context.idempotencyKey}:competitive-spawn`,
        openedAt: now,
        expiresAt: new Date(now.getTime() + COMPETITIVE_SPAWN_TTL_MS),
      },
      COMPETITIVE_SPAWN_COOLDOWN_MS,
    );
    if (created === null) return ok(null);

    return ok({
      resultRefType: "COMPETITIVE_SPAWN",
      resultRefId: created.id,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "IMAGE",
          payload: {
            caption: "*✨ Um Pokémon selvagem apareceu!*",
            replyToExternalMessageId: null,
            competitiveSpawnRender: created.renderSpec,
          },
          idempotencyKey: `competitive-spawn:${created.id}:image`,
        },
      ],
    });
  }

  public async manageGroup(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    const group = await this.dependencies.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!isGameGroup(group)) {
      return ok({
        resultRefType: null,
        resultRefId: null,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: { text: "Este recurso só pode ser configurado em um grupo GAME do RPG." },
            idempotencyKey: `${context.idempotencyKey}:competitive-admin-invalid-group`,
          },
        ],
      });
    }

    const action = parseCompetitiveSpawnAdminAction(context.message.text);
    if (action === null) {
      return ok({
        resultRefType: "COMMUNITY_GROUP",
        resultRefId: group.groupId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: {
              text: [
                "◇ *𝗦𝗣𝗔𝗪𝗡 𝗖𝗢𝗠𝗣𝗘𝗧𝗜𝗧𝗜𝗩𝗢*",
                "",
                "`/competitivo ativar`",
                "`/competitivo desativar`",
                "`/competitivo status`",
                "`/competitivo incenso [30m|1h]`",
                "`/competitivo incenso parar`",
                "`/competitivo forçar`",
              ].join("\n"),
            },
            idempotencyKey: `${context.idempotencyKey}:competitive-admin-help`,
          },
        ],
      });
    }

    const now = this.now();
    const stateMessage = async (suffix: string): Promise<MessageHandlerResult> => {
      const enabled = await this.dependencies.settings.isEnabled(group.groupId);
      const incenseUntil =
        this.dependencies.settings.incenseUntil === undefined
          ? null
          : await this.dependencies.settings.incenseUntil(group.groupId, now);
      const incenseText =
        incenseUntil === null
          ? "DESATIVADO"
          : `ATIVO · ${Math.max(1, Math.ceil((incenseUntil.getTime() - now.getTime()) / 60_000))}min`;

      return {
        resultRefType: "COMMUNITY_GROUP",
        resultRefId: group.groupId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: {
              text: [
                "◇ *𝗦𝗣𝗔𝗪𝗡 𝗖𝗢𝗠𝗣𝗘𝗧𝗜𝗧𝗜𝗩𝗢*",
                `Estado · \`${enabled ? "ATIVO" : "DESATIVADO"}\``,
                `Incenso · \`${incenseText}\``,
                "Grupo · `este grupo`",
              ].join("\n"),
            },
            idempotencyKey: `${context.idempotencyKey}:competitive-admin-${suffix}`,
          },
        ],
      };
    };

    if (action.kind === "STATUS") return ok(await stateMessage("status"));

    if (action.kind === "ENABLE" || action.kind === "DISABLE") {
      await this.dependencies.settings.setEnabled({
        communityGroupId: group.groupId,
        enabled: action.kind === "ENABLE",
        now,
      });
      return ok(await stateMessage("state"));
    }

    const enabled = await this.dependencies.settings.isEnabled(group.groupId);
    if (!enabled) {
      return ok({
        resultRefType: "COMMUNITY_GROUP",
        resultRefId: group.groupId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: { text: "Ative o competitivo neste grupo antes de usar este controle." },
            idempotencyKey: `${context.idempotencyKey}:competitive-admin-disabled`,
          },
        ],
      });
    }

    if (action.kind === "INCENSE_START" || action.kind === "INCENSE_STOP") {
      if (this.dependencies.settings.setIncense === undefined) {
        throw new Error("Competitive spawn Incense persistence is unavailable");
      }
      await this.dependencies.settings.setIncense({
        communityGroupId: group.groupId,
        incenseUntil:
          action.kind === "INCENSE_START" ? new Date(now.getTime() + action.durationMs) : null,
        now,
      });
      return ok(
        await stateMessage(action.kind === "INCENSE_START" ? "incense-start" : "incense-stop"),
      );
    }

    const forced = await this.resolve(context, { bypassActivity: true });
    if (!forced.ok) return forced;
    if (forced.value !== null) return ok(forced.value);

    return ok({
      resultRefType: "COMMUNITY_GROUP",
      resultRefId: group.groupId,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "TEXT",
          payload: {
            text: "Não foi possível forçar agora: há spawn ativo, cooldown em curso ou a pool não está disponível.",
          },
          idempotencyKey: `${context.idempotencyKey}:competitive-admin-force-blocked`,
        },
      ],
    });
  }

  public async reconcilePublication(): Promise<{
    readonly published: number;
    readonly cancelled: number;
  }> {
    return this.dependencies.repository.reconcilePublication({
      now: this.now(),
      ttlMs: COMPETITIVE_SPAWN_TTL_MS,
      orphanGraceMs: COMPETITIVE_SPAWN_PUBLICATION_ORPHAN_GRACE_MS,
      limit: 100,
    });
  }

  public async expireDue(): Promise<number> {
    return this.dependencies.repository.expireDue(this.now(), 100);
  }

  public async resolveGuessCommand(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const group = await this.dependencies.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!isGameGroup(group)) return ok(null);
    if (!(await this.dependencies.settings.isEnabled(group.groupId))) return ok(null);

    const now = this.now();
    const active = await this.dependencies.repository.activeForGroup(group.groupId);
    if (active === null || active.expiresAt.getTime() <= now.getTime()) return ok(null);

    const commandText = context.message.text?.trim() ?? "";
    const guessText = commandText.replace(/^\/[^\s]+\s*/u, "").trim();
    const guess = normalizeCompetitiveSpawnGuess(guessText);
    if (guess.length === 0) return ok(emptyResult(active.id));

    const player = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!player.ok) return ok(null);

    const guessAdmitted = await this.dependencies.repository.consumeGuessBudget({
      spawnId: active.id,
      playerId: player.value.playerId,
      now,
      minIntervalMs: COMPETITIVE_SPAWN_GUESS_MIN_INTERVAL_MS,
      maxAttempts: COMPETITIVE_SPAWN_GUESS_MAX_PER_PLAYER,
    });
    if (!guessAdmitted) return ok(emptyResult(active.id));

    if (!active.normalizedAnswers.includes(guess)) {
      await this.dependencies.repository.recordWrongGuess({
        spawnId: active.id,
        inboxMessageId: context.inboxMessageId,
        playerId: player.value.playerId,
        senderRef: context.message.senderRef,
        normalizedGuess: guess,
      });
      return ok(emptyResult(active.id));
    }

    const claimed = await this.dependencies.repository.claimCorrect({
      spawnId: active.id,
      inboxMessageId: context.inboxMessageId,
      playerId: player.value.playerId,
      senderRef: context.message.senderRef,
      normalizedGuess: guess,
      idempotencyKey: `${context.idempotencyKey}:competitive-spawn-win`,
      correlationId: context.correlationId,
      rewardKindRoll: this.dependencies.rng.randomInt(10_000),
      rewardAmountRoll: this.dependencies.rng.randomInt(10_000),
      rewardItemRoll: this.dependencies.rng.randomInt(10_000),
      pokemonBonusRoll: this.dependencies.rng.randomInt(10_000),
      now,
    });
    if (claimed.kind !== "WON") return ok(emptyResult(active.id));

    // Base reward application and the winner message are durable maintenance work.
    // Returning no immediate output avoids a crash window between WON and reward delivery.
    return ok(emptyResult(claimed.spawn.id));
  }
}
export function createCompetitiveSpawnAdminRoute(
  service: CompetitiveSpawnService,
): CommandRouteDefinition {
  return {
    command: "competitivo",
    rateLimitClass: "SENSITIVE",
    policy: {
      requiredAnyGroupCapabilities: ["pve", "world"],
      requiredAdminCapability: "community.group.manage",
    },
    handler: {
      handle: (context) => service.manageGroup(context),
    },
  };
}

export function createCompetitiveSpawnGuessRoute(
  service: CompetitiveSpawnService,
): CommandRouteDefinition {
  return {
    command: "c",
    aliases: ["catch"],
    rateLimitClass: "STANDARD",
    policy: {
      requiredAnyGroupCapabilities: ["pve", "world"],
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    },
    handler: {
      handle: async (context) => {
        const resolved = await service.resolveGuessCommand(context);
        if (!resolved.ok) return resolved;
        return ok(resolved.value ?? emptyResult());
      },
    },
  };
}
