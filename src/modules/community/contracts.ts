export const COMMUNITY_GROUP_ROLES = [
  "RECEPTION",
  "GAME",
  "PVP",
  "COMMUNITY",
  "STAFF",
] as const;

export type CommunityGroupRole = (typeof COMMUNITY_GROUP_ROLES)[number];

export const COMMUNITY_CAPABILITIES = [
  "onboarding",
  "player.basic",
  "admin.review",
  "world",
  "pve",
  "pvp",
  "admin",
  "observability",
] as const;

export type CommunityCapability = (typeof COMMUNITY_CAPABILITIES)[number];

export type CommunityGroupStatus = "ACTIVE" | "RETIRED";

export interface CommunityGroupRecord {
  readonly id: string;
  readonly provider: string;
  readonly chatRef: string;
  readonly role: CommunityGroupRole;
  readonly displayName: string;
  readonly status: CommunityGroupStatus;
  readonly revision: number;
}

export interface CommunityChatContext {
  readonly known: boolean;
  readonly groupId: string | null;
  readonly role: CommunityGroupRole | null;
  readonly capabilities: readonly CommunityCapability[];
}

export interface RegisterCommunityGroupInput {
  readonly provider: string;
  readonly chatRef: string;
  readonly role: CommunityGroupRole;
  readonly displayName: string;
}

export interface RenameCommunityGroupInput {
  readonly groupId: string;
  readonly displayName: string;
  readonly expectedRevision: number;
}

export interface ReplaceCommunityCapabilitiesInput {
  readonly groupId: string;
  readonly capabilities: readonly CommunityCapability[];
  readonly expectedRevision: number;
}

export interface RetireCommunityGroupInput {
  readonly groupId: string;
  readonly expectedRevision: number;
}

export interface AssignReceptionStaffInput {
  readonly groupId: string;
  readonly adminPrincipalId: string;
}

export interface ResolveCommunityChatInput {
  readonly provider: string;
  readonly chatRef: string;
}
