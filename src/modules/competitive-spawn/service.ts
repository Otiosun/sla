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
  parseCompetitiveSpawnToggle,
} from "./settings.js";

export const COMPETITIVE_SPAWN_COOLDOWN_MS = 7 * 60_000;
export const COMPETITIVE_SPAWN_TTL_MS = 5 * 60_000;
export const COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT = 35;
export const COMPETITIVE_SPAWN_GUESS_MIN_INTERVAL_MS = 1_200;
export const COMPETITIVE_SPAWN_GUESS_MAX_PER_PLAYER = 50;
export const COMPETITIVE_SPAWN_PUBLICATION_ORPHAN_GRACE_MS = 2 * 60_000;

const PROTOTYPE_BACKGROUND_URL =
  "https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/main/backgrounds/1.png";

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
  const base = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other";
  const artworkPath = shiny
    ? `official-artwork/shiny/${nationalDex}.png`
    : `official-artwork/${nationalDex}.png`;
  const artworkUrl = `${base}/${artworkPath}`;

  return {
    schemaVersion: 1,
    backgroundUrl: PROTOTYPE_BACKGROUND_URL,
    spriteUrl: artworkUrl,
    fallbackSpriteUrl: artworkUrl,
    centerX: 455 + rng.randomInt(91),
    groundY: 438,
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
      now: this.now(),
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

    const activity = await this.dependencies.activity.stateForGroup(group.groupId, now);
    if (activity.targetMilli === null || activity.progressMilli < activity.targetMilli) {
      return ok(null);
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
            caption: "✨ Um Pokémon selvagem apareceu!",
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

    const action = parseCompetitiveSpawnToggle(context.message.text);
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
              ].join("\n"),
            },
            idempotencyKey: `${context.idempotencyKey}:competitive-admin-help`,
          },
        ],
      });
    }

    const enabled =
      action === "STATUS"
        ? await this.dependencies.settings.isEnabled(group.groupId)
        : (
            await this.dependencies.settings.setEnabled({
              communityGroupId: group.groupId,
              enabled: action === "ENABLE",
              now: this.now(),
            })
          ).enabled;

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
              `Estado · \`${enabled ? "ATIVO" : "DESATIVADO"}\``,
              "Grupo · `este grupo`",
            ].join("\n"),
          },
          idempotencyKey: `${context.idempotencyKey}:competitive-admin-state`,
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
