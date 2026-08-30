import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(repositoryRoot, "dist");
const tscEntrypoint = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

await rm(distDirectory, { recursive: true, force: true });

const compile = spawnSync(process.execPath, [tscEntrypoint, "-p", "tsconfig.build.json"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (compile.error !== undefined) {
  throw compile.error;
}
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const bridgeTarget = join(distDirectory, "src", "adapters", "whatsapp", "baileys-runtime.js");
await mkdir(dirname(bridgeTarget), { recursive: true });
await copyFile(
  join(repositoryRoot, "src", "adapters", "whatsapp", "baileys-runtime.js"),
  bridgeTarget,
);

await cp(join(repositoryRoot, "db", "migrations"), join(distDirectory, "db", "migrations"), {
  recursive: true,
});
