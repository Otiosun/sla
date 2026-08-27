import { z } from "zod";

export const PlayerStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

const identityProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const Player360GetRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    playerId: z.string().uuid(),
    includeSensitive: z.boolean().default(false),
  })
  .strict();
export type Player360GetRequest = z.infer<typeof Player360GetRequestSchema>;

export const Player360SearchRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    status: PlayerStatusSchema.optional(),
    trainerNamePrefix: z.string().trim().min(1).max(80).optional(),
    originRegionId: z.string().uuid().optional(),
    identityProvider: identityProviderSchema.optional(),
    externalId: z.string().trim().min(1).max(256).optional(),
    includeSensitive: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasProvider = value.identityProvider !== undefined;
    const hasExternalId = value.externalId !== undefined;
    if (hasProvider !== hasExternalId) {
      context.addIssue({
        code: "custom",
        message: "identityProvider and externalId must be supplied together",
      });
    }
    if (hasExternalId && !value.includeSensitive) {
      context.addIssue({
        code: "custom",
        message: "external identity lookup requires includeSensitive=true",
      });
    }
  });
export type Player360SearchRequest = z.infer<typeof Player360SearchRequestSchema>;

export interface Player360SearchCursor {
  readonly createdAt: string;
  readonly playerId: string;
}

export interface Player360IdentityView {
  readonly provider: string;
  readonly externalId: string | null;
  readonly status: "ACTIVE" | "REVOKED";
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface Player360ProfileView {
  readonly trainerName: string | null;
  readonly originRegionId: string | null;
  readonly locale: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly revision: string | null;
}

export interface Player360OnboardingView {
  readonly state: string | null;
  readonly completedAt: string | null;
  readonly revision: string | null;
  readonly contentReleaseId: string | null;
  readonly rulesetId: string | null;
}

export interface Player360ProgressionView {
  readonly level: number;
  readonly insigniaPoints: string;
  readonly revision: string;
  readonly unlocks: readonly {
    readonly key: string;
    readonly status: "ACTIVE" | "REVOKED";
    readonly sourceType: string;
    readonly sourceId: string;
    readonly unlockedAt: string;
    readonly revokedAt: string | null;
    readonly revision: string;
  }[];
}

export interface Player360WalletView {
  readonly currencyId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly amount: string;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface Player360InventoryView {
  readonly itemId: string;
  readonly slug: string;
  readonly quantity: string;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface Player360PokemonMoveView {
  readonly slotNo: number;
  readonly moveId: string;
  readonly slug: string;
  readonly ppCurrent: number | null;
  readonly learnedAt: string;
}

export interface Player360PokemonView {
  readonly id: string;
  readonly formId: string;
  readonly formSlug: string;
  readonly speciesId: string;
  readonly speciesSlug: string;
  readonly nationalDex: number;
  readonly nickname: string | null;
  readonly level: number;
  readonly xp: string;
  readonly currentHp: number;
  readonly gender: string | null;
  readonly shiny: boolean;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly abilityId: string | null;
  readonly abilitySlug: string | null;
  readonly natureId: string | null;
  readonly natureSlug: string | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly placement: {
    readonly kind: "TEAM" | "BOX";
    readonly boxNo: number | null;
    readonly slotNo: number;
  } | null;
  readonly ivs: {
    readonly hp: number | null;
    readonly attack: number | null;
    readonly defense: number | null;
    readonly spAttack: number | null;
    readonly spDefense: number | null;
    readonly speed: number | null;
  };
  readonly moves: readonly Player360PokemonMoveView[];
  readonly persistentConditions: readonly {
    readonly key: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly appliedAt: string;
    readonly expiresAt: string | null;
  }[];
  readonly evolutionConditionFlags: readonly {
    readonly key: string;
    readonly status: "ACTIVE" | "REVOKED";
    readonly sourceType: string;
    readonly sourceId: string;
    readonly grantedAt: string;
    readonly revokedAt: string | null;
    readonly revision: string;
  }[];
}

export interface Player360PokedexEntryView {
  readonly speciesId: string;
  readonly nationalDex: number;
  readonly slug: string;
  readonly seenCount: string;
  readonly caughtCount: string;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly firstCaughtAt: string | null;
  readonly lastCaughtAt: string | null;
}

export interface Player360EffectView {
  readonly id: string;
  readonly effectId: string;
  readonly effectSlug: string;
  readonly contentReleaseId: string;
  readonly playerId: string | null;
  readonly pokemonInstanceId: string | null;
}

export interface Player360EncounterView {
  readonly id: string;
  readonly status: string;
  readonly areaId: string;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Player360BattleView {
  readonly id: string;
  readonly status: string;
  readonly battleType: string;
  readonly encounterId: string | null;
  readonly contentReleaseId: string;
  readonly rulesetId: string;
  readonly turnNumber: number;
  readonly version: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface Player360ActivityView {
  readonly kind: "TRAINER_PROGRESS" | "INVENTORY" | "WALLET" | "POKEMON_HISTORY";
  readonly occurredAt: string;
  readonly subjectId: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reason: string | null;
  readonly correlationId: string | null;
}

export interface Player360View {
  readonly player: {
    readonly id: string;
    readonly status: PlayerStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly revision: string;
  };
  readonly profile: Player360ProfileView;
  readonly identities: readonly Player360IdentityView[];
  readonly onboarding: Player360OnboardingView;
  readonly progression: Player360ProgressionView;
  readonly location: {
    readonly areaId: string;
    readonly enteredAt: string;
    readonly revision: string;
  } | null;
  readonly wallets: readonly Player360WalletView[];
  readonly inventory: readonly Player360InventoryView[];
  readonly pokemon: readonly Player360PokemonView[];
  readonly pokedex: {
    readonly speciesSeen: number;
    readonly speciesCaught: number;
    readonly entries: readonly Player360PokedexEntryView[];
  };
  readonly activeEncounter: Player360EncounterView | null;
  readonly activeBattle: Player360BattleView | null;
  readonly effects: readonly Player360EffectView[];
  readonly recentActivity: readonly Player360ActivityView[];
  readonly unsupportedSections: readonly ["COOLDOWNS", "PUNISHMENTS_FLAGS"];
}

export interface Player360SearchItemView {
  readonly playerId: string;
  readonly status: PlayerStatus;
  readonly trainerName: string | null;
  readonly originRegionId: string | null;
  readonly trainerLevel: number;
  readonly insigniaPoints: string;
  readonly areaId: string | null;
  readonly activeEncounterId: string | null;
  readonly activeEncounterStatus: string | null;
  readonly activeBattleId: string | null;
  readonly activeBattleStatus: string | null;
  readonly identities: readonly Player360IdentityView[];
  readonly createdAt: string;
}

export interface Player360SearchResultView {
  readonly items: readonly Player360SearchItemView[];
  readonly nextCursor: string | null;
}
