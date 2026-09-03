import { describe, expect, it } from "vitest";
import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLE_CAPABILITIES,
} from "../../src/modules/admin/registry-catalog.js";

const REVIEW_CAPABILITIES = [
  "player.registration.read",
  "player.registration.request_changes",
  "player.registration.approve",
  "player.registration.reject",
] as const;

describe("registration review admin capability catalog", () => {
  it("registers granular review capabilities with bounded risk and grants them to senior/owner roles", () => {
    const risks = new Map<string, number>(ADMIN_CAPABILITIES);
    expect(risks.get("player.registration.read")).toBe(0);
    expect(risks.get("player.registration.request_changes")).toBe(1);
    expect(risks.get("player.registration.approve")).toBe(2);
    expect(risks.get("player.registration.reject")).toBe(2);

    for (const capability of REVIEW_CAPABILITIES) {
      expect(ADMIN_ROLE_CAPABILITIES.SENIOR_ADMIN).toContain(capability);
      expect(ADMIN_ROLE_CAPABILITIES.OWNER_SECURITY_ADMIN).toContain(capability);
    }
  });
});
