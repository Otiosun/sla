import { describe, expect, it } from "vitest";
import {
  MIGRATOR_ROLE,
  type PsqlRunner,
  RUNTIME_ROLE,
  transitionLegacyPostgresRoles,
  transitionMode,
} from "../../scripts/operations/transition-legacy-postgres-roles.js";

type Relation = { relkind: "r" | "p" | "S" | "v" | "m"; relname: string; owner: string };

function fakeClient(
  initial: readonly Relation[],
  options: { thirdParty?: boolean; runtimeCreate?: boolean } = {},
) {
  const relations = initial.map((relation) => ({ ...relation }));
  let roles = new Set<string>();
  const queries: string[] = [];
  const client = {
    query: async (sql: string, _values?: readonly unknown[]) => {
      queries.push(sql);
      if (sql.startsWith("SELECT current_user"))
        return {
          rows: [{ current_user: "postgres", session_user: "postgres", database: "postgres" }],
        };
      if (sql.includes("FROM pg_roles"))
        return { rows: [...roles].map((rolname) => ({ rolname })) };
      if (sql.includes("FROM pg_class AS c") && sql.includes("ORDER BY c.relkind")) {
        return {
          rows: options.thirdParty
            ? [...relations, { relkind: "r", relname: "foreign", owner: "other" }]
            : relations,
        };
      }
      if (sql.includes("pg_get_userbyid(c.relowner) <> $2")) {
        return {
          rows: [
            {
              count: relations
                .filter((relation) => relation.owner !== MIGRATOR_ROLE)
                .length.toString(),
            },
          ],
        };
      }
      if (sql.includes("has_schema_privilege"))
        return { rows: [{ runtime_can_create: options.runtimeCreate ?? false }] };
      if (sql.startsWith("ALTER ")) {
        const name = sql.match(/public\."(.+)" OWNER/)?.[1];
        const relation = relations.find((item) => item.relname === name);
        if (relation) relation.owner = MIGRATOR_ROLE;
      }
      return { rows: [] };
    },
  };
  const psql: PsqlRunner = async ({ script }) => {
    if (script === "roles.sql") roles = new Set([MIGRATOR_ROLE, RUNTIME_ROLE]);
  };
  return { client, queries, relations, psql };
}

const ownerUrl = "postgresql://postgres:secret@localhost:5432/postgres";
const migratorUrl = "postgresql://pokemon_migrator:secret@localhost:5432/postgres";
const apply = {
  migratorDatabaseUrl: migratorUrl,
  migratorPassword: "secret",
  runtimePassword: "runtime",
};

describe("legacy postgres role transition", () => {
  it("defaults to dry-run and requires the exact second confirmation for apply", () => {
    expect(transitionMode([], {})).toBe("dry-run");
    expect(() => transitionMode(["--apply"], {})).toThrow("LEGACY_DB_ROLE_TRANSITION_CONFIRM");
    expect(
      transitionMode(["--apply"], {
        LEGACY_DB_ROLE_TRANSITION_CONFIRM: "TRANSFER_POSTGRES_OWNERSHIP",
      }),
    ).toBe("apply");
  });

  it("dry-run does not persist roles, ownership, or grants", async () => {
    const fixture = fakeClient([{ relkind: "r", relname: "players", owner: "postgres" }]);
    const report = await transitionLegacyPostgresRoles(
      fixture.client as never,
      "dry-run",
      ownerUrl,
      null,
      fixture.psql,
    );
    expect(report.decision).toBe("SAFE_TO_APPLY");
    expect(fixture.queries.some((query) => query.startsWith("ALTER "))).toBe(false);
    expect(fixture.queries).not.toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(fixture.relations[0]?.owner).toBe("postgres");
  });

  it("aborts before mutation when public has a third-party owner", async () => {
    const fixture = fakeClient([{ relkind: "r", relname: "players", owner: "postgres" }], {
      thirdParty: true,
    });
    await expect(
      transitionLegacyPostgresRoles(
        fixture.client as never,
        "apply",
        ownerUrl,
        apply,
        fixture.psql,
      ),
    ).rejects.toThrow("unexpected owner");
    expect(fixture.queries.some((query) => query.startsWith("ALTER "))).toBe(false);
  });

  it("transfers only postgres-owned relation kinds and leaves already migrated objects untouched", async () => {
    const fixture = fakeClient([
      { relkind: "r", relname: "players", owner: "postgres" },
      { relkind: "S", relname: "players_id_seq", owner: "postgres" },
      { relkind: "v", relname: "player_view", owner: MIGRATOR_ROLE },
    ]);
    const report = await transitionLegacyPostgresRoles(
      fixture.client as never,
      "apply",
      ownerUrl,
      apply,
      fixture.psql,
    );
    expect(report.decision).toBe("SAFE_TO_APPLY");
    expect(fixture.queries.filter((query) => query.startsWith("ALTER "))).toHaveLength(2);
    expect(fixture.relations.every((relation) => relation.owner === MIGRATOR_ROLE)).toBe(true);
  });

  it("is idempotent after a valid transition", async () => {
    const fixture = fakeClient([{ relkind: "p", relname: "events", owner: "postgres" }]);
    await transitionLegacyPostgresRoles(
      fixture.client as never,
      "apply",
      ownerUrl,
      apply,
      fixture.psql,
    );
    fixture.queries.length = 0;
    await transitionLegacyPostgresRoles(
      fixture.client as never,
      "apply",
      ownerUrl,
      apply,
      fixture.psql,
    );
    expect(fixture.queries.some((query) => query.startsWith("ALTER "))).toBe(false);
  });

  it("fails postcondition if runtime has CREATE outside the canonical grants contract", async () => {
    const fixture = fakeClient([{ relkind: "m", relname: "summary", owner: "postgres" }], {
      runtimeCreate: true,
    });
    await expect(
      transitionLegacyPostgresRoles(
        fixture.client as never,
        "apply",
        ownerUrl,
        apply,
        fixture.psql,
      ),
    ).rejects.toThrow("runtime retains CREATE");
  });
});
