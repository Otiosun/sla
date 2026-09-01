import { describe, expect, it } from "vitest";
import type {
  CommunityCapability,
  CommunityGroupRecord,
  CommunityGroupRole,
  CommunityGroupStatus,
} from "../../src/modules/community/contracts.js";
import type {
  CommunityRepository,
  CommunityTransaction,
} from "../../src/modules/community/ports.js";
import { CommunityService } from "../../src/modules/community/service.js";

interface MutableGroup {
  id: string;
  provider: string;
  chatRef: string;
  role: CommunityGroupRole;
  displayName: string;
  status: CommunityGroupStatus;
  revision: number;
}

class MemoryCommunityRepository implements CommunityRepository {
  readonly groups = new Map<string, MutableGroup>();
  readonly capabilities = new Map<string, Set<CommunityCapability>>();
  readonly staff = new Map<string, Set<string>>();
  nextId = 1;

  private transactionView(): CommunityTransaction {
    return {
      loadGroupByProviderRef: async (provider, chatRef) =>
        [...this.groups.values()].find(
          (group) => group.provider === provider && group.chatRef === chatRef,
        ) ?? null,
      loadGroupById: async (groupId) => this.groups.get(groupId) ?? null,
      listGroupsByRole: async (role) =>
        [...this.groups.values()].filter((group) => group.role === role),
      listCapabilities: async (groupId) => [...(this.capabilities.get(groupId) ?? new Set())],
      insertGroup: async (input) => {
        if (
          [...this.groups.values()].some(
            (group) => group.provider === input.provider && group.chatRef === input.chatRef,
          )
        ) {
          return null;
        }
        const id = `group-${this.nextId++}`;
        const group: MutableGroup = {
          id,
          provider: input.provider,
          chatRef: input.chatRef,
          role: input.role,
          displayName: input.displayName,
          status: "ACTIVE",
          revision: 0,
        };
        this.groups.set(id, group);
        return { ...group };
      },
      renameGroup: async (groupId, displayName, expectedRevision) => {
        const group = this.groups.get(groupId);
        if (group === undefined || group.revision !== expectedRevision) return null;
        group.displayName = displayName;
        group.revision += 1;
        return { ...group };
      },
      replaceCapabilities: async (groupId, capabilities, expectedRevision) => {
        const group = this.groups.get(groupId);
        if (group === undefined || group.revision !== expectedRevision) return null;
        this.capabilities.set(groupId, new Set(capabilities));
        group.revision += 1;
        return { ...group };
      },
      retireGroup: async (groupId, expectedRevision) => {
        const group = this.groups.get(groupId);
        if (group === undefined || group.revision !== expectedRevision) return null;
        group.status = "RETIRED";
        group.revision += 1;
        return { ...group };
      },
      assignReceptionStaff: async (groupId, adminPrincipalId) => {
        const assigned = this.staff.get(groupId) ?? new Set<string>();
        assigned.add(adminPrincipalId);
        this.staff.set(groupId, assigned);
      },
      listReceptionStaff: async (groupId) => [...(this.staff.get(groupId) ?? new Set())],
    };
  }

  async transaction<T>(work: (tx: CommunityTransaction) => Promise<T>): Promise<T> {
    return work(this.transactionView());
  }

  async read<T>(work: (tx: CommunityTransaction) => Promise<T>): Promise<T> {
    return work(this.transactionView());
  }
}

async function createReception(
  service: CommunityService,
  chatRef: string,
  displayName: string,
): Promise<CommunityGroupRecord> {
  const created = await service.registerGroup({
    provider: "WHATSAPP",
    chatRef,
    role: "RECEPTION",
    displayName,
  });
  if (!created.ok) throw created.error;
  return created.value;
}

describe("CommunityService group registry", () => {
  it("resolves authorization by provider + chatRef and ignores display-name collisions", async () => {
    const repository = new MemoryCommunityRepository();
    const service = new CommunityService(repository);
    const reception = await createReception(service, "120363000001@g.us", "Recepção Kanto");

    const capabilities = await service.replaceCapabilities({
      groupId: reception.id,
      expectedRevision: reception.revision,
      capabilities: ["onboarding", "player.basic"],
    });
    expect(capabilities.ok).toBe(true);

    const renamed = await service.renameGroup({
      groupId: reception.id,
      expectedRevision: capabilities.ok ? capabilities.value.revision : -1,
      displayName: "Lobby Principal",
    });
    expect(renamed.ok).toBe(true);

    const resolved = await service.resolveChat({
      provider: "WHATSAPP",
      chatRef: "120363000001@g.us",
    });
    expect(resolved.known).toBe(true);
    expect(resolved.role).toBe("RECEPTION");
    expect(resolved.capabilities).toEqual(["onboarding", "player.basic"]);

    const sameNameWrongRef = await service.resolveChat({
      provider: "WHATSAPP",
      chatRef: "Lobby Principal",
    });
    expect(sameNameWrongRef).toEqual({
      known: false,
      groupId: null,
      role: null,
      capabilities: [],
    });
  });

  it("allows multiple active RECEPTION groups without overwriting one another", async () => {
    const repository = new MemoryCommunityRepository();
    const service = new CommunityService(repository);
    await createReception(service, "120363000101@g.us", "Recepção A");
    await createReception(service, "120363000102@g.us", "Recepção B");

    const receptions = await service.listActiveGroupsByRole("RECEPTION");
    expect(receptions.map((group) => group.chatRef).sort()).toEqual([
      "120363000101@g.us",
      "120363000102@g.us",
    ]);
  });

  it("fails closed for unknown and retired groups", async () => {
    const repository = new MemoryCommunityRepository();
    const service = new CommunityService(repository);

    expect(
      await service.resolveChat({ provider: "WHATSAPP", chatRef: "unknown@g.us" }),
    ).toEqual({ known: false, groupId: null, role: null, capabilities: [] });

    const group = await createReception(service, "120363000201@g.us", "Recepção antiga");
    const withCapability = await service.replaceCapabilities({
      groupId: group.id,
      expectedRevision: group.revision,
      capabilities: ["onboarding", "admin.review"],
    });
    if (!withCapability.ok) throw withCapability.error;

    const retired = await service.retireGroup({
      groupId: group.id,
      expectedRevision: withCapability.value.revision,
    });
    expect(retired.ok).toBe(true);

    expect(
      await service.resolveChat({ provider: "WHATSAPP", chatRef: group.chatRef }),
    ).toEqual({ known: false, groupId: null, role: null, capabilities: [] });
  });

  it("does not turn Reception staff assignment into a group admin capability", async () => {
    const repository = new MemoryCommunityRepository();
    const service = new CommunityService(repository);
    const group = await createReception(service, "120363000301@g.us", "Recepção");
    const withCapabilities = await service.replaceCapabilities({
      groupId: group.id,
      expectedRevision: group.revision,
      capabilities: ["onboarding", "player.basic"],
    });
    if (!withCapabilities.ok) throw withCapabilities.error;

    const assigned = await service.assignReceptionStaff({
      groupId: group.id,
      adminPrincipalId: "admin-principal-1",
    });
    expect(assigned.ok).toBe(true);

    const resolved = await service.resolveChat({
      provider: "WHATSAPP",
      chatRef: group.chatRef,
    });
    expect(resolved.capabilities).toEqual(["onboarding", "player.basic"]);
    expect(resolved.capabilities).not.toContain("admin");
    expect(await service.listReceptionStaff(group.id)).toEqual(["admin-principal-1"]);
  });
});
