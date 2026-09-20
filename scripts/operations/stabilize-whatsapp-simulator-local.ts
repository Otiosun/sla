import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GEN123_SOURCE } from "../../db/imports/gen123/source.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function databaseName(raw: string): string {
  const url = new URL(raw);
  const value = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!value) throw new Error("DATABASE_NAME_MISSING");
  return value;
}

function run(
  label: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  console.log(JSON.stringify({ event: "local.stability.step", label, status: "START" }));
  execFileSync(command, [...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  console.log(JSON.stringify({ event: "local.stability.step", label, status: "PASS" }));
}

const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  readonly engines?: { readonly node?: string; readonly pnpm?: string };
};
const expectedNode = packageJson.engines?.node;
if (!expectedNode || process.version.replace(/^v/u, "") !== expectedNode) {
  throw new Error(
    `NODE_VERSION_MISMATCH expected=${expectedNode ?? "missing"} actual=${process.version}`,
  );
}

if (process.env.LOCAL_SIMULATOR_RESET !== "1") {
  throw new Error("LOCAL_SIMULATOR_RESET=1_REQUIRED");
}

const sourceUrl = requiredEnv("DATABASE_URL");
const simulatorUrl = requiredEnv("SIMULATOR_DATABASE_URL");
const pokeapiDataDir = requiredEnv("POKEAPI_DATA_DIR");
if (sourceUrl === simulatorUrl) throw new Error("SIMULATOR_DATABASE_MUST_DIFFER_FROM_SOURCE");
const sourceName = databaseName(sourceUrl);
const simulatorName = databaseName(simulatorUrl);
if (!/simulator/iu.test(simulatorName)) {
  throw new Error(`SIMULATOR_DATABASE_NAME_NOT_EXPLICITLY_DISPOSABLE ${simulatorName}`);
}
if (/simulator/iu.test(sourceName)) {
  throw new Error(`SOURCE_DATABASE_LOOKS_DISPOSABLE_OR_WRONG ${sourceName}`);
}

const gitStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const unexpected = gitStatus
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((line) => !/^\?\? \.sim-pokeapi(?:\/|$)/u.test(line));
if (unexpected.length > 0) {
  throw new Error(`WORKTREE_NOT_CLEAN ${JSON.stringify(unexpected)}`);
}

const pokeapiRevision = execFileSync("git", ["-C", pokeapiDataDir, "rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (pokeapiRevision !== GEN123_SOURCE.commit) {
  throw new Error(
    `POKEAPI_PIN_MISMATCH expected=${GEN123_SOURCE.commit} actual=${pokeapiRevision}`,
  );
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const node = process.execPath;
const simulatorEnv = {
  DATABASE_URL: simulatorUrl,
  MIGRATOR_DATABASE_URL: simulatorUrl,
  SIMULATOR_DATABASE_URL: simulatorUrl,
  POKEAPI_DATA_DIR: pokeapiDataDir,
};
const sourceAndTargetEnv = {
  DATABASE_URL: sourceUrl,
  SIMULATOR_DATABASE_URL: simulatorUrl,
  POKEAPI_DATA_DIR: pokeapiDataDir,
  SIMULATOR_RESET: "1",
};

function rebuildPristine(labelPrefix: string): void {
  run(
    `${labelPrefix}:clone-and-migrate`,
    node,
    ["--import", "tsx", "scripts/operations/bootstrap-whatsapp-simulator-db.ts"],
    sourceAndTargetEnv,
  );
  run(
    `${labelPrefix}:gen123-high-fidelity`,
    node,
    ["--import", "tsx", "scripts/operations/prepare-whatsapp-simulator-gen123-content.ts"],
    simulatorEnv,
  );
  run(
    `${labelPrefix}:seed-simulator-fixture`,
    node,
    ["--import", "tsx", "scripts/operations/seed-whatsapp-simulator-fixture.ts"],
    simulatorEnv,
  );
  run(
    `${labelPrefix}:verify-pristine`,
    node,
    ["--import", "tsx", "scripts/operations/verify-whatsapp-simulator-local.ts"],
    {
      DATABASE_URL: sourceUrl,
      SIMULATOR_DATABASE_URL: simulatorUrl,
      POKEAPI_DATA_DIR: pokeapiDataDir,
    },
  );
}

run("static-check", pnpm, ["check"], process.env);
rebuildPristine("proof");

for (const [label, script] of [
  ["multi-actor", "db/proofs/whatsapp_simulator_multi_actor_uat.ts"],
  ["deep-gameplay", "db/proofs/whatsapp_simulator_deep_gameplay_uat.ts"],
  ["stress-swarm", "db/proofs/whatsapp_simulator_stress_uat.ts"],
] as const) {
  run(
    `uat:${label}`,
    node,
    ["--import", "tsx", script],
    simulatorEnv,
  );
}

// UATs intentionally mutate the disposable simulator. Rebuild once more so the
// operator is left with the same pristine high-fidelity state that was proven.
rebuildPristine("final");

console.log(
  JSON.stringify({
    event: "local.stability.complete",
    sourceDatabase: sourceName,
    simulatorDatabase: simulatorName,
    pokeapiRevision,
    state: "PRISTINE_HIGH_FIDELITY_READY",
  }),
);
