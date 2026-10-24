#!/usr/bin/env node
/**
 * Read-only inventory of Git metadata for an operator-selected worktree.
 * No env files, backup artifacts, player data, PM2 state or DB are opened.
 * The script neither creates files nor prints local paths or filenames.
 *
 * Usage: node <path-to-this-script> --repo <operator-selected-worktree>
 * Git is invoked with optional locks disabled to avoid index refresh writes.
 */
import { spawnSync } from "node:child_process";

const EXPECTED_BASE = "19a29bf19cff00d569e81238a47de4c24001bf1f398";
const CATEGORIES = ["src", "db", "tests", "docs", "scripts", "assets", "other"];

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout;
}

function countStatus(porcelain) {
  const entries = porcelain.split("\0").filter(Boolean);
  const result = {
    tracked: 0,
    untracked: 0,
    staged: 0,
    unstaged: 0,
    unmerged: 0,
    byDirectory: Object.fromEntries(CATEGORIES.map((category) => [category, 0])),
  };

  for (const entry of entries) {
    if (entry.length < 4 || entry[2] !== " ") return null;
    const xy = entry.slice(0, 2);
    const name = entry.slice(3);
    if (!name) return null;
    if (xy === "??") result.untracked += 1;
    else {
      result.tracked += 1;
      if (xy[0] !== " ") result.staged += 1;
      if (xy[1] !== " ") result.unstaged += 1;
      if (xy.includes("U") || xy === "AA" || xy === "DD") result.unmerged += 1;
    }
    const top = name.includes("/") ? name.split("/")[0] : "other";
    const category = CATEGORIES.includes(top) ? top : "other";
    result.byDirectory[category] += 1;
  }
  return result;
}

function failClosed(reason) {
  process.stdout.write(
    JSON.stringify({
      event: "pokemon.premium.worktree.inventory",
      ok: false,
      reason,
      readOnly: true,
      releaseEligible: false,
      backupAndRestoreEvidence: "NOT_ASSESSED",
    }) + "\n",
  );
  process.exitCode = 2;
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--repo" || args[1].trim().length === 0) {
  failClosed("USAGE_REQUIRES_EXPLICIT_REPO");
} else {
  const cwd = args[1];
  const head = runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const status = runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  if (head === null || status === null || !/^[0-9a-f]{40}\s*$/.test(head)) {
    failClosed("GIT_METADATA_UNAVAILABLE");
  } else {
    const counted = countStatus(status);
    if (counted === null) {
      failClosed("GIT_STATUS_NOT_PARSEABLE");
    } else {
      const branch = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      process.stdout.write(
        JSON.stringify({
          event: "pokemon.premium.worktree.inventory",
          ok: true,
          readOnly: true,
          gitHead: head.trim(),
          detachedHead: branch === null,
          matchesPreviouslyObservedBase: head.trim() === EXPECTED_BASE,
          changes: { ...counted, total: counted.tracked + counted.untracked },
          sensitiveFilenamesIncluded: false,
          releaseEligible: false,
          backupAndRestoreEvidence: "NOT_ASSESSED",
          requiredIndependentProofs: [
            "local-differences-reconciled",
            "private-patch-restored-in-disposable-clone",
            "database-backup-restored-and-verified",
            "baileys-auth-and-ignored-files-preserved",
            "running-dist-and-pm2-revision-mapped",
            "active-catalog-readonly-audited",
            "uat-and-rollback-approved",
          ],
        }) + "\n",
      );
    }
  }
}
