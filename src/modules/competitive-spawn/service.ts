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
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type {
  CompetitiveSpawnCandidate,
  CompetitiveSpawnRecord,
  CompetitiveSpawnRenderSpec,
  CompetitiveSpawnRepository,
} from "./contracts.js";
import {
  competitiveSpawnTimeBucket,
  competitiveSpawnTrigger,
  normalizeCompetitiveSpawnGuess,
} from "./normalization.js";

export const COMPETITIVE_SPAWN_TRIGGER_DENOMINATOR = 18;
export const COMPETITIVE_SPAWN_COOLDOWN_MS = 120_000;
export const COMPETITIVE_SPAWN_TTL_MS = 10 * 60_000;
export const COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT = 35;

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
  const homePath = shiny ? `home/shiny/${nationalDex}.png` : `home/${nationalDex}.png`;
  const artworkPath = shiny
    ? `official-artwork/shiny/${nationalDex}.png`
    : `official-artwork/${nationalDex}.png`;

  return {
    schemaVersion: 1,
    backgroundUrl: PROTOTYPE_BACKGROUND_URL,
    spriteUrl: `${base}/${homePath}`,
    fallbackSpriteUrl: `${base}/${artworkPath}`,
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

function mentionToken(senderRef: string): string | null {
  const match = senderRef.match(/^(\d+)@s\.whatsapp\.net$/u);
  return match?.[1] ?? null;
}

export class CompetitiveSpawnService {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: CompetitiveSpawnDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async admits(message: IncomingMessage): Promise<boolean> {
    if (message.text === null || message.text.trim().length === 0) return false;
    const group = await this.dependencies.community.resolveChat({
      provider: message.provider,
      chatRef: message.chatRef,
    });
    if (!isGameGroup(group)) return false;

    const active = await this.dependencies.repository.activeForGroup(group.groupId);
    if (active !== null && active.expiresAt.getTime() > this.now().getTime()) return true;
    if (!competitiveSpawnTrigger(message, COMPETITIVE_SPAWN_TRIGGER_DENOMINATOR)) return false;
    return this.dependencies.repository.canOpen(
      group.groupId,
      this.now(),
      COMPETITIVE_SPAWN_COOLDOWN_MS,
    );
  }

  public async resolve(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const text = context.message.text?.trim() ?? "";
    if (text.length === 0) return ok(null);

    const group = await this.dependencies.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!isGameGroup(group)) return ok(null);

    const now = this.now();
    await this.dependencies.repository.expireDue(now, 50);

    const active = await this.dependencies.repository.activeForGroup(group.groupId);
    if (active !== null) {
      return this.resolveGuess(context, active, now);
    }

    if (!competitiveSpawnTrigger(context.message, COMPETITIVE_SPAWN_TRIGGER_DENOMINATOR)) {
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
            caption: "\u2728 Um Pokemon selvagem apareceu!",
            competitiveSpawnRender: created.renderSpec,
          },
          idempotencyKey: `competitive-spawn:${created.id}:image`,
        },
      ],
    });
  }

  public async expireDue(): Promise<number> {
    return this.dependencies.repository.expireDue(this.now(), 100);
  }

  private async resolveGuess(
    context: MessageHandlerContext,
    active: CompetitiveSpawnRecord,
    now: Date,
  ): Promise<Result<MessageHandlerResult | null>> {
    const guess = normalizeCompetitiveSpawnGuess(context.message.text ?? "");
    if (guess.length === 0) return ok(null);

    const player = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!player.ok) return ok(null);

    if (!active.normalizedAnswers.includes(guess)) {
      await this.dependencies.repository.recordWrongGuess({
        spawnId: active.id,
        inboxMessageId: context.inboxMessageId,
        playerId: player.value.playerId,
        senderRef: context.message.senderRef,
        normalizedGuess: guess,
      });
      return ok(null);
    }

    const claimed = await this.dependencies.repository.claimCorrect({
      spawnId: active.id,
      inboxMessageId: context.inboxMessageId,
      playerId: player.value.playerId,
      senderRef: context.message.senderRef,
      normalizedGuess: guess,
      idempotencyKey: `${context.idempotencyKey}:competitive-spawn-win`,
      now,
    });
    if (claimed.kind !== "WON") return ok(emptyResult(active.id));

    const phone = mentionToken(context.message.senderRef);
    const display = phone === null ? (claimed.trainerName ?? "Treinador") : `@${phone}`;
    const destination =
      claimed.placement.placementKind === "TEAM"
        ? `Equipe slot ${claimed.placement.slotNo}`
        : `Box ${claimed.placement.boxNo} slot ${claimed.placement.slotNo}`;
    const shinyLine = claimed.spawn.shiny ? "\n\u2728 Shiny" : "";

    return ok({
      resultRefType: "COMPETITIVE_SPAWN",
      resultRefId: claimed.spawn.id,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "TEXT",
          payload: {
            text:
              `\uD83C\uDF89 ${display} foi o primeiro!\n\n` +
              `*${claimed.spawn.speciesDisplayName}* \u00B7 Nv. ${claimed.spawn.level}` +
              `${shinyLine}\n> ${destination}`,
            ...(phone === null ? {} : { mentions: [context.message.senderRef] }),
          },
          idempotencyKey: `competitive-spawn:${claimed.spawn.id}:winner`,
        },
      ],
    });
  }
}
