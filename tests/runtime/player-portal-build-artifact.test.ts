import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

describe("Player Portal build artifact", () => {
  it("builds the dedicated production entrypoint and exposes an explicit start script", () => {
    const build = spawnSync(process.execPath, ["scripts/build-runtime.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync("dist/src/player-portal-main.js")).toBe(true);

    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    expect(packageJson.scripts?.["start:player-portal:prod"]).toBe(
      "node dist/src/player-portal-main.js",
    );
  }, 30_000);
});
