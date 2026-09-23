import { describe, expect, it } from "vitest";
import {
  cleanupMode,
  cleanupUatIntegrationDebris,
  foreignKeyMetadataQuery,
} from "../../scripts/operations/cleanup-uat-integration-debris.js";

type Scenario = "valid" | "principal-role" | "extra-identity" | "mixed-party";

function fakeClient(scenario: Scenario) {
  const queries: string[] = [];
  const client = {
    query: async (input: string) => {
      queries.push(input);
      if (input.includes("FROM pg_constraint")) return { rows: [] };
      const count =
        (scenario === "principal-role" && input.includes("FROM admin_principal_roles")) ||
        (scenario === "extra-identity" && input.includes("FROM cleanup_players player WHERE")) ||
        (scenario === "mixed-party" &&
          input.includes("FROM player_party_members WHERE party_id IN"))
          ? "1"
          : "0";
      return { rows: [{ count }] };
    },
  };
  return { client, queries };
}

describe("UAT integration debris cleanup guard", () => {
  it("does not use CONSTRAINT as the pg_constraint table alias", () => {
    expect(foreignKeyMetadataQuery).not.toMatch(/\bpg_constraint\s+constraint\b/i);
  });

  it("defaults to dry-run", () => {
    expect(cleanupMode([], {})).toBe("dry-run");
  });

  it("rejects apply without the second confirmation", () => {
    expect(() => cleanupMode(["--apply"], {})).toThrow("UAT_INTEGRATION_DEBRIS_CLEANUP_CONFIRM");
  });

  it("accepts apply only with the exact confirmation", () => {
    expect(
      cleanupMode(["--apply"], {
        UAT_INTEGRATION_DEBRIS_CLEANUP_CONFIRM: "DELETE_UAT_INTEGRATION_DEBRIS",
      }),
    ).toBe("apply");
  });

  it("uses a rollback-only transaction in dry-run mode", async () => {
    const { client, queries } = fakeClient("valid");
    await cleanupUatIntegrationDebris(client as never, "dry-run");
    expect(queries).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(queries).toContain("ROLLBACK");
    expect(queries.some((query) => query.startsWith("DELETE"))).toBe(false);
    expect(queries).not.toContain("COMMIT");
  });

  it("aborts and rolls back when a UAT principal has a role", async () => {
    const { client, queries } = fakeClient("principal-role");
    await expect(cleanupUatIntegrationDebris(client as never, "apply")).rejects.toThrow(
      "principal role",
    );
    expect(queries).toContain("ROLLBACK");
    expect(queries.some((query) => query.startsWith("DELETE"))).toBe(false);
  });

  it("aborts and rolls back when a target player has an additional identity", async () => {
    const { client, queries } = fakeClient("extra-identity");
    await expect(cleanupUatIntegrationDebris(client as never, "apply")).rejects.toThrow(
      "additional player identity",
    );
    expect(queries).toContain("ROLLBACK");
    expect(queries.some((query) => query.startsWith("DELETE"))).toBe(false);
  });

  it("aborts and rolls back when a target party contains a real player", async () => {
    const { client, queries } = fakeClient("mixed-party");
    await expect(cleanupUatIntegrationDebris(client as never, "apply")).rejects.toThrow(
      "mixed party",
    );
    expect(queries).toContain("ROLLBACK");
    expect(queries.some((query) => query.startsWith("DELETE"))).toBe(false);
  });

  it("deletes only the explicitly enumerated UAT debris tables after valid assertions", async () => {
    const { client, queries } = fakeClient("valid");
    await cleanupUatIntegrationDebris(client as never, "apply");
    const deletes = queries.filter((query) => query.startsWith("DELETE"));
    expect(deletes).toHaveLength(21);
    expect(deletes).toContain(
      "DELETE FROM admin_principals WHERE id IN (SELECT id FROM cleanup_principals)",
    );
    expect(deletes.every((query) => query.includes("cleanup_"))).toBe(true);
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
  });
});
