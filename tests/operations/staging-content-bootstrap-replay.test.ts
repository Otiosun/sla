import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  verifiedMigrations: vi.fn(),
  assertZhoulia: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    query = mock.query;
    async connect() {
      return { query: mock.query, release: mock.release };
    }
    async end() {
      mock.end();
    }
  },
}));
vi.mock("../../src/platform/db/migrations.js", () => ({
  loadMigrations: async () => [],
  verifyAppliedMigrations: mock.verifiedMigrations,
}));
vi.mock("../../src/platform/world/postgres-zhoulia-exclusive-release.js", () => ({
  assertZhouliaExclusiveRelease: mock.assertZhoulia,
  reconcileZhouliaExclusiveRelease: vi.fn(),
}));

import {
  STAGING_GEN123_RELEASE_ID,
  bootstrapStagingContent,
} from "../../scripts/operations/staging-content-bootstrap.js";

const PHASE4_ID = "00000000-0000-4000-8000-000000000004";
const originalEnv = {
  APP_ENV: process.env.APP_ENV,
  DEPLOY_REVISION: process.env.DEPLOY_REVISION,
  DATABASE_URL: process.env.DATABASE_URL,
};

const phase4 = {
  id: PHASE4_ID,
  release_no: 1,
  status: "PUBLISHED",
  ruleset_key: "phase4-core-v1",
  ruleset_version: 1,
};
const candidate = {
  id: STAGING_GEN123_RELEASE_ID,
  release_no: 15001,
  status: "PUBLISHED",
  ruleset_key: "gen123-core",
  ruleset_version: 1,
};

function setCatalogState(mode: "ACTIVE_ZHOULIA" | "EMPTY" | "ONLY_PHASE4"): void {
  mock.query.mockImplementation(async (query: string) => {
    if (query.includes("FROM content_releases release") && query.includes("release_no=1")) {
      return {
        rows: mode === "EMPTY" ? [] : mode === "ONLY_PHASE4" ? [phase4] : [phase4, candidate],
      };
    }
    if (query.includes("FROM content_release_pointers pointer")) {
      return { rows: mode === "EMPTY" ? [] : [mode === "ACTIVE_ZHOULIA" ? candidate : phase4] };
    }
    if (query.includes("FROM content_releases\n")) return { rows: [{ count: 0 }] };
    if (query.includes("FROM rulesets\n")) return { rows: [{ count: 0 }] };
    if (query.includes("FROM pokemon_species_revisions revision"))
      return { rows: [{ count: 386 }] };
    throw new Error(`Unexpected query in isolated test: ${query}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENV = "staging";
  process.env.DEPLOY_REVISION = "0000000000000000000000000000000000000001";
  process.env.DATABASE_URL = "postgresql://example.invalid/disposable-test";
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name as keyof typeof originalEnv];
    else process.env[name as keyof typeof originalEnv] = value;
  }
  vi.restoreAllMocks();
});

describe("staging content bootstrap — Premium replay safety", () => {
  it("verifies an already-active Zhoulia release without needing to choose starters", async () => {
    setCatalogState("ACTIVE_ZHOULIA");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(bootstrapStagingContent()).resolves.toEqual({
      releaseId: STAGING_GEN123_RELEASE_ID,
      replayed: true,
      species: 386,
    });

    expect(mock.assertZhoulia).toHaveBeenCalledTimes(1);
    expect(mock.query).toHaveBeenCalledTimes(9);
    expect(mock.query.mock.calls.every(([sql]) => /^\s*SELECT\b/u.test(sql as string))).toBe(true);
    expect(mock.verifiedMigrations).toHaveBeenCalledTimes(1);
    expect(mock.end).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("rejects a new seed before any catalog data can be modified without approved starters", async () => {
    setCatalogState("EMPTY");

    await expect(bootstrapStagingContent()).rejects.toThrow(
      "Canonical Zhoulia starter set is not configured",
    );

    expect(mock.assertZhoulia).not.toHaveBeenCalled();
    expect(mock.query).toHaveBeenCalledTimes(4);
    expect(mock.query.mock.calls.every(([sql]) => /^\s*SELECT\b/u.test(sql as string))).toBe(true);
    expect(mock.end).toHaveBeenCalledTimes(1);
  });

  it("rejects a Phase 4-only promotion rather than inferring starters from Gen I-III", async () => {
    setCatalogState("ONLY_PHASE4");

    await expect(bootstrapStagingContent()).rejects.toThrow(
      "refusing to infer it from Gen I-III source starters",
    );

    expect(mock.assertZhoulia).not.toHaveBeenCalled();
    expect(mock.query).toHaveBeenCalledTimes(4);
    expect(mock.query.mock.calls.every(([sql]) => /^\s*SELECT\b/u.test(sql as string))).toBe(true);
    expect(mock.end).toHaveBeenCalledTimes(1);
  });
});
