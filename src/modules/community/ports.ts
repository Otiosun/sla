import type {
  CommunityCapability,
  CommunityGroupRecord,
  CommunityGroupRole,
  RegisterCommunityGroupInput,
} from "./contracts.js";

export interface CommunityTransaction {
  loadGroupByProviderRef(provider: string, chatRef: string): Promise<CommunityGroupRecord | null>;
  loadGroupById(groupId: string): Promise<CommunityGroupRecord | null>;
  listGroupsByRole(role: CommunityGroupRole): Promise<readonly CommunityGroupRecord[]>;
  listCapabilities(groupId: string): Promise<readonly CommunityCapability[]>;
  insertGroup(input: RegisterCommunityGroupInput): Promise<CommunityGroupRecord | null>;
  renameGroup(
    groupId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<CommunityGroupRecord | null>;
  replaceCapabilities(
    groupId: string,
    capabilities: readonly CommunityCapability[],
    expectedRevision: number,
  ): Promise<CommunityGroupRecord | null>;
  retireGroup(groupId: string, expectedRevision: number): Promise<CommunityGroupRecord | null>;
  assignReceptionStaff(groupId: string, adminPrincipalId: string): Promise<void>;
  listReceptionStaff(groupId: string): Promise<readonly string[]>;
}

export interface CommunityRepository {
  transaction<T>(work: (tx: CommunityTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (tx: CommunityTransaction) => Promise<T>): Promise<T>;
}
