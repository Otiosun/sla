import type { PlayerId } from "../../shared-kernel/ids.js";
import type {
  ContentContext,
  ExternalIdentity,
  OnboardingRecord,
  PlayerProfileView,
  ProfileInput,
  RosterPlacement,
  StarterBuild,
  StarterGrantRecord,
  StarterGrantWrite,
  StarterOption,
} from "./contracts.js";

export interface StoredProfile {
  readonly trainerName: string;
  readonly locale: string | null;
  readonly metadata: Readonly<Record<string, never>>;
  readonly originRegionId: string | null;
}

export interface PlayerOnboardingTransaction {
  acquireIdentityLock(identity: ExternalIdentity): Promise<void>;
  findPlayerByIdentity(identity: ExternalIdentity): Promise<PlayerId | null>;
  loadActiveContentContext(): Promise<ContentContext | null>;
  createPlayerFoundation(input: {
    readonly playerId: PlayerId;
    readonly identityId: string;
    readonly identity: ExternalIdentity;
    readonly context: ContentContext;
  }): Promise<void>;
  loadOnboarding(playerId: PlayerId, lock?: boolean): Promise<OnboardingRecord | null>;
  loadProfile(playerId: PlayerId): Promise<StoredProfile | null>;
  createProfile(input: {
    readonly playerId: PlayerId;
    readonly profile: ProfileInput;
    readonly expectedRevision: bigint;
  }): Promise<boolean>;
  regionIsActive(contentReleaseId: string, regionId: string): Promise<boolean>;
  selectRegion(input: {
    readonly playerId: PlayerId;
    readonly regionId: string;
    readonly expectedRevision: bigint;
  }): Promise<boolean>;
  listStarterOptions(
    contentReleaseId: string,
    regionId: string,
  ): Promise<readonly StarterOption[]>;
  setStarterPending(input: {
    readonly playerId: PlayerId;
    readonly starterClaimKey: string;
    readonly expectedRevision: bigint;
  }): Promise<boolean>;
  findStarterGrant(playerId: PlayerId): Promise<StarterGrantRecord | null>;
  loadStarterBuild(input: {
    readonly contentReleaseId: string;
    readonly rulesetId: string;
    readonly regionId: string;
    readonly formId: string;
  }): Promise<StarterBuild | null>;
  nextRosterPlacement(playerId: PlayerId): Promise<RosterPlacement>;
  createStarterBundle(input: StarterGrantWrite): Promise<boolean>;
  completeOnboarding(input: {
    readonly playerId: PlayerId;
    readonly completedAt: Date;
    readonly expectedRevision: bigint;
  }): Promise<boolean>;
  loadProfileView(playerId: PlayerId): Promise<PlayerProfileView | null>;
}

export interface PlayerOnboardingRepository {
  transaction<T>(work: (transaction: PlayerOnboardingTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: PlayerOnboardingTransaction) => Promise<T>): Promise<T>;
}
