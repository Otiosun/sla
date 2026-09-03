import { describe, expect, it } from "vitest";
import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLE_CAPABILITIES,
} from "../../src/modules/admin/registry-catalog.js";

const REGISTRATION_CAPABILITIES = [
  "player.registration.read",
  "player.registration.request_changes",
  "player.registration.approve",
  "player.registration.reject",
  "player.registration.reopen",
  "player.access.suspend",
  "player.access.restore",
  "community.group.manage",
  "community.reception.staff.manage",
] as const;

const RECEPTION_REVIEW_CAPABILITIES = [
  "player.registration.read",
  "player.registration.request_changes",
  "player.registration.approve",
  "player.registration.reject",
] as const;

describe("registration and reception admin capability catalog", () => {
  it("registers the complete least-privilege capability surface", () => {
    const risks = new Map<string, number>(ADMIN_CAPABILITIES);

    for (const capability of REGISTRATION_CAPABILITIES) {
      expect(risks.has(capability)).toBe(true);
    }
  });

  it("packages capabilities in roles without making role names the authorization primitive", () => {
    for (const capability of RECEPTION_REVIEW_CAPABILITIES) {
      expect(ADMIN_ROLE_CAPABILITIES.RECEPTION_MOD).toContain(capability);
    }

    for (const capability of REGISTRATION_CAPABILITIES) {
      expect(ADMIN_ROLE_CAPABILITIES.ADMIN).toContain(capability);
      expect(ADMIN_ROLE_CAPABILITIES.MASTER_ADMIN).toContain(capability);
      expect(ADMIN_ROLE_CAPABILITIES.OWNER_SECURITY_ADMIN).toContain(capability);
    }
  });

  it("does not grant unrelated high-risk administration to Reception moderators", () => {
    expect(ADMIN_ROLE_CAPABILITIES.RECEPTION_MOD).not.toContain("admin.role.manage");
    expect(ADMIN_ROLE_CAPABILITIES.RECEPTION_MOD).not.toContain("content.publish");
    expect(ADMIN_ROLE_CAPABILITIES.RECEPTION_MOD).not.toContain("admin.override.invariant");
  });
});
