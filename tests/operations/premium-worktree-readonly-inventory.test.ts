import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const inspector = fileURLToPath(
  new URL("../../scripts/operations/premium-worktree-readonly-inventory.mjs", import.meta.url),
);

function exec(command: string, args: string[], cwd: string): string {
  const run = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (run.status !== 0) {
    throw new Error(`Disposable test command failed: ${command} ${args[0] ?? ""}`);
  }
  return run.stdout.trim();
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pokemon-worktree-inventory-fixture-"));
  exec("git", ["init", "-b", "main", "--quiet"], dir);
  exec("git", ["config", "user.email", "test@example.invalid"], dir);
  exec("git", ["config", "user.name", "Disposable CI Test"], dir);
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "src", "hidden-secret-token.txt"), "fixture");
  writeFileSync(join(dir, "tests", "original.test.ts"), "fixture");
  exec("git", ["add", "."], dir);
  exec("git", ["commit", "--quiet", "-m", "fixture"], dir);
  return dir;
}

function inspect(repo: string, environment: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [inspector, "--repo", repo], {
    cwd: tmpdir(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
  return {
    status: run.status,
    stdout: run.stdout,
    report: JSON.parse(run.stdout),
  };
}

describe("Premium private worktree read-only inventory", () => {
  it("returns only aggregate counts for a dirty worktree without exposing names or secrets", () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "src", "hidden-secret-token.txt"), "changed");
      unlinkSync(join(dir, "tests", "original.test.ts"));
      mkdirSync(join(dir, "db"));
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "db", "private-DB-credential.sql"), "do-not-log");
      writeFileSync(join(dir, "assets", "very-private.png"), "do-not-log");
      const indexBefore = statSync(join(dir, ".git", "index")).mtimeMs;
      const result = inspect(dir, {
        DATABASE_URL: "postgres://private:ENV_SECRET_TOKEN@localhost/prod",
      });
      expect(result.status).toBe(0);
      expect(result.report).toMatchObject({
        ok: true,
        readOnly: true,
        detachedHead: false,
        matchesPreviouslyObservedBase: false,
        sensitiveFilenamesIncluded: false,
        releaseEligible: false,
        backupAndRestoreEvidence: "NOT_ASSESSED",
        changes: {
          tracked: 2,
          untracked: 2,
          total: 4,
          byDirectory: { src: 1, tests: 1, db: 1, assets: 1 },
        },
      });
      for (const forbidden of [
        dir,
        "hidden-secret",
        "private-DB",
        "very-private",
        "ENV_SECRET_TOKEN",
        "do-not-log",
      ]) {
        expect(result.stdout).not.toContain(forbidden);
      }
      expect(statSync(join(dir, ".git", "index")).mtimeMs).toBe(indexBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports detached HEAD and does not equate a clean tree with restore readiness", () => {
    const dir = fixture();
    try {
      exec("git", ["checkout", "--detach", "--quiet", "HEAD"], dir);
      const result = inspect(dir);
      expect(result.status).toBe(0);
      expect(result.report.detachedHead).toBe(true);
      expect(result.report.changes.total).toBe(0);
      expect(result.report.releaseEligible).toBe(false);
      expect(result.report.requiredIndependentProofs).toContain(
        "database-backup-restored-and-verified",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with no local path disclosure for a missing repository", () => {
    const target = join(tmpdir(), "missing-pokemon-worktree-never-created");
    const result = inspect(target);
    expect(result.status).toBe(2);
    expect(result.report).toMatchObject({
      ok: false,
      reason: "GIT_METADATA_UNAVAILABLE",
      releaseEligible: false,
      backupAndRestoreEvidence: "NOT_ASSESSED",
    });
    expect(result.stdout).not.toContain(target);
  });

  it("fails closed if the operator does not explicitly select a repository", () => {
    const run = spawnSync(process.execPath, [inspector], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).reason).toBe("USAGE_REQUIRES_EXPLICIT_REPO");
  });

  it("does not contain a filesystem write, PM2, database or provider implementation", () => {
    const source = readFileSync(inspector, "utf8");
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|mkdir|rename|unlink|rmSync)\s*\(/);
    expect(source).not.toContain("pg");
    expect(source).not.toContain("pm2");
    expect(source).not.toContain("baileys");
    expect(source).not.toContain("git reset");
  });
});
