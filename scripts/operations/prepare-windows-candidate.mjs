import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const REQUIRED = [
  "dist",
  "package.json",
  "pnpm-lock.yaml",
  "db/migrations",
  "scripts/operations/release-local-readonly-preflight.ps1",
  "scripts/operations/verify-windows-candidate.mjs",
];
const SHA = /^[0-9a-f]{40}$/u;
const BAD_PATH =
  /(^|\/)(?:\.env(?:\.[^/]*)?|auth_info_baileys|node_modules|\.git|\.npmrc|\.ssh|\.aws|\.pnpm-store|\.DS_Store)(?:\/|$)/iu;

function must(condition, message) {
  if (!condition) throw new Error(message);
}

async function filesSafe(source, root) {
  const rel = relative(root, source).replaceAll(sep, "/");
  must(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel), "Unsafe relative path");
  must(!BAD_PATH.test("/" + rel), "Private path prohibited in bundle");
  const info = await lstat(source);
  must(!info.isSymbolicLink(), "Symlinks cannot be bundled");
  if (info.isDirectory()) {
    for (const entry of await readdir(source)) {
      await filesSafe(join(source, entry), root);
    }
  } else {
    must(info.isFile(), "Only regular files may be bundled");
  }
}

async function scanFiles(directory, prefix = "") {
  const out = [];
  for (const entry of (await readdir(directory)).sort()) {
    if (entry === "manifest.json") continue;
    const path = join(directory, entry);
    const item = prefix === "" ? entry : prefix + "/" + entry;
    const info = await lstat(path);
    if (info.isDirectory()) out.push(...(await scanFiles(path, item)));
    else {
      const content = await readFile(path);
      out.push({
        path: item,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return out;
}

async function main() {
  const [origin, destination] = process.argv.slice(2);
  must(
    process.argv.length === 4 && origin && destination,
    "Usage: prepare-windows-candidate.mjs <checkout> <new-bundle-directory>",
  );
  must(
    process.env.CI === "true" &&
      process.env.APP_ENV === "test" &&
      process.env.WHATSAPP_ENABLED === "false",
    "Candidate bundle creation requires isolated CI; never a live bot",
  );
  must(SHA.test(process.env.GITHUB_SHA ?? ""), "GITHUB_SHA must identify an exact audited commit");
  const root = resolve(origin);
  const out = resolve(destination);
  must(
    out !== root &&
      !REQUIRED.some((path) => out === join(root, path) || out.startsWith(join(root, path) + sep)),
    "Destination overlaps required source",
  );
  for (const path of REQUIRED) await filesSafe(join(root, path), root);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  must(
    pkg.packageManager === "pnpm@11.23.0" && pkg.engines?.node === "24.19.0",
    "Pinned Node/pnpm contract changed",
  );
  const migrations = (await readdir(join(root, "db/migrations"))).filter((name) =>
    name.endsWith(".sql"),
  );
  must(
    migrations.includes("0079_stage2_move_acquisition_methods.sql"),
    "Active schema baseline is incomplete",
  );
  await mkdir(out, { recursive: false, mode: 0o700 });
  try {
    for (const path of REQUIRED) {
      const dest = join(out, path);
      const segments = path.split("/");
      segments.pop();
      if (segments.length) await mkdir(join(out, ...segments), { recursive: true });
      await cp(join(root, path), dest, { recursive: true, errorOnExist: true, force: false });
    }
    await writeFile(
      join(out, "READ_ME_FIRST.txt"),
      [
        "POKEMON BEYOND - PREINSTALLATION ARTIFACT - NO-GO",
        "This is only a compiled candidate for audit; do not execute on a live Windows host.",
        "No local DB, media, session, runtime secrets, node_modules or PM2 state are included.",
        "Active migrations are source copies only; do not run before approved restore rehearsal.",
        "The V4 0080 draft is NOT an active migration; published gameplay odds need approval.",
        "Verify file hashes offline: node scripts/operations/verify-windows-candidate.mjs <dir> <trusted-Git-SHA>.",
        "Hashes detect corruption but do NOT authenticate the archive or authorize installation.",
        "Use the included read-only PowerShell preflight after checking clone identity.",
        "This artifact is not installable without dependencies, content and owner GO.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const files = await scanFiles(out);
    must(
      files.some((file) => file.path === "dist/src/main.js"),
      "Compiled bot entrypoint is missing",
    );
    const manifest = {
      format: "pokemon-beyond-preinstall-windows-v1",
      gitSha: process.env.GITHUB_SHA,
      result: "NO_GO_INSPECTION_ONLY",
      productionDatabaseTouched: false,
      requiresOwnerApproval: true,
      v4MigrationActive: false,
      dependenciesIncluded: false,
      files,
    };
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
    });
    console.log("Candidate audited - files:", files.length, "NO-GO until full Fase A gate");
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error("Windows preinstallation bundle refused:", error?.message ?? "unknown error");
  process.exitCode = 1;
});
