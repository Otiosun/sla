from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_once(path: str, old: str, new: str, label: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor in {path}, found {count}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex match in {path}, found {count}")
    write(path, updated)


# 1. Public catalog contract: starter selection is content, not an out-of-band table.
replace_once(
    "src/modules/catalog/contracts.ts",
    "  readonly encounterTables: readonly {\n",
    """  readonly starterOptions: readonly {
    readonly regionId: string;
    readonly formId: string;
    readonly starterLevel: number;
    readonly sortOrder: number;
    readonly active: boolean;
  }[];
  readonly encounterTables: readonly {
""",
    "contracts snapshot",
)
replace_once(
    "src/modules/catalog/contracts.ts",
    '  "evolutions",\n] as const;',
    '  "evolutions",\n  "starterOptions",\n] as const;',
    "contracts diff category",
)

# 2. Fingerprint and release diff must observe starter changes.
replace_once(
    "src/modules/catalog/fingerprint.ts",
    "    evolutions: sortByCanonical(snapshot.evolutions),\n    encounterTables:",
    "    evolutions: sortByCanonical(snapshot.evolutions),\n    starterOptions: sortByCanonical(snapshot.starterOptions),\n    encounterTables:",
    "catalog fingerprint",
)
replace_once(
    "src/modules/catalog/diff.ts",
    "    encounterTables: snapshot.encounterTables.map((entry) => ({\n",
    """    starterOptions: snapshot.starterOptions.map((entry) => ({
      key: `${entry.regionId}:${entry.formId}`,
      value: entry,
    })),
    encounterTables: snapshot.encounterTables.map((entry) => ({
""",
    "catalog diff",
)

# 3. Validation protects references, active state, ranges and logical uniqueness.
replace_once(
    "src/modules/catalog/validation.ts",
    "  const activeAbilityByForm = new Map<string, number>();\n",
    """  const starterOptionKeys = new Set<string>();
  for (const [index, starter] of snapshot.starterOptions.entries()) {
    const logicalKey = `${starter.regionId}:${starter.formId}`;
    if (starterOptionKeys.has(logicalKey)) {
      issues.push(
        issue(
          "STARTER_OPTION_DUPLICATE",
          `starterOptions.${index}`,
          "Starter option duplicates a region/form pair in this release",
        ),
      );
    }
    starterOptionKeys.add(logicalKey);

    if (!allRegionIds.has(starter.regionId) || !allFormIds.has(starter.formId)) {
      issues.push(
        issue(
          "STARTER_OPTION_REFERENCE_MISSING",
          `starterOptions.${index}`,
          "Starter option references a region or form absent from this release",
        ),
      );
    }

    if (
      starter.active &&
      (!activeRegionIds.has(starter.regionId) || !activeFormIds.has(starter.formId))
    ) {
      issues.push(
        issue(
          "ACTIVE_STARTER_OPTION_INVALID",
          `starterOptions.${index}`,
          "Active starter option references inactive content",
        ),
      );
    }

    if (
      !Number.isSafeInteger(starter.starterLevel) ||
      starter.starterLevel < 1 ||
      starter.starterLevel > 100 ||
      !Number.isSafeInteger(starter.sortOrder) ||
      starter.sortOrder < 0
    ) {
      issues.push(
        issue(
          "STARTER_OPTION_RANGE_INVALID",
          `starterOptions.${index}`,
          "Starter level must be 1..100 and sort order must be a non-negative safe integer",
        ),
      );
    }
  }

  const activeAbilityByForm = new Map<string, number>();
""",
    "catalog validation",
)

# 4. PostgreSQL snapshot loader and clone lifecycle.
repo = "src/platform/catalog/postgres-catalog-repository.ts"
replace_once(
    repo,
    "      evolutions,\n      encounterTables,\n",
    "      evolutions,\n      starterOptions,\n      encounterTables,\n",
    "snapshot destructuring",
)
regex_once(
    repo,
    r"(\n\s{6}this\.client\.query<\{\n\s+revision_id: string;\n\s+encounter_table_id: string;\n\s+area_id: string;\n\s+active: boolean;\n\s+\}>\()",
    """
      this.client.query<{
        region_id: string;
        form_id: string;
        starter_level: number;
        sort_order: number;
        active: boolean;
      }>(
        `SELECT region_id, form_id, starter_level, sort_order, active
         FROM starter_options
         WHERE content_release_id = $1 ORDER BY region_id, sort_order, form_id`,
        [releaseId],
      ),\1""",
    "snapshot starter query",
)
replace_once(
    repo,
    "      encounterTables: tableRows,\n      parentCoverage,\n",
    """      starterOptions: starterOptions.rows.map((entry) => ({
        regionId: entry.region_id,
        formId: entry.form_id,
        starterLevel: entry.starter_level,
        sortOrder: entry.sort_order,
        active: entry.active,
      })),
      encounterTables: tableRows,
      parentCoverage,
""",
    "snapshot return",
)
regex_once(
    repo,
    r'(\n\s*\{\n\s*table: "evolution_rules",\n\s*columns: \[[^\]]*\],\n\s*\},)(\n\s*\] as const;)',
    r'''\1
      {
        table: "starter_options",
        columns: ["region_id", "form_id", "starter_level", "sort_order", "active"],
      },\2''',
    "clone starter options",
)

# 5. Contract tests prove validation, fingerprint and diff semantics.
test = "tests/catalog/catalog-contracts.test.ts"
replace_once(
    test,
    "    evolutions: [],\n    encounterTables: [\n",
    """    evolutions: [],
    starterOptions: [
      {
        regionId: "region-1",
        formId: "form-1",
        starterLevel: 5,
        sortOrder: 1,
        active: true,
      },
    ],
    encounterTables: [
""",
    "catalog fixture starter options",
)
replace_once(
    test,
    '  it("produces a readable release diff without changing historical snapshots", () => {\n',
    """  it("treats starter options as fingerprinted, validated and diffable content", () => {
    const before = validSnapshot("release-1");
    const starter = before.starterOptions[0];
    expect(starter).toBeDefined();
    if (starter === undefined) return;

    const after: CatalogSnapshotWithEffects = {
      ...validSnapshot("release-2"),
      starterOptions: [{ ...starter, starterLevel: 10 }],
    };
    expect(fingerprintCatalog(after)).not.toBe(fingerprintCatalog(before));
    expect(
      diffCatalogSnapshots(before, after).sections.find(
        (section) => section.category === "starterOptions",
      ),
    ).toEqual({ category: "starterOptions", added: 0, removed: 0, changed: 1 });

    const invalid: CatalogSnapshotWithEffects = {
      ...before,
      starterOptions: [{ ...starter, formId: "missing-form", starterLevel: 0 }],
    };
    const report = validateCatalogSnapshot(invalid);
    expect(report.valid).toBe(false);
    expect(
      report.issues.some((entry) => entry.code === "STARTER_OPTION_REFERENCE_MISSING"),
    ).toBe(true);
    expect(report.issues.some((entry) => entry.code === "STARTER_OPTION_RANGE_INVALID")).toBe(true);
  });

  it("produces a readable release diff without changing historical snapshots", () => {
""",
    "catalog starter lifecycle test",
)

# 6. PostgreSQL integration proves published-release cloning carries starter assignments.
integration = "tests/db/player-onboarding.integration.test.ts"
replace_once(
    integration,
    'import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";\n',
    'import { CatalogService } from "../../src/modules/catalog/service.js";\nimport { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";\n',
    "catalog service import",
)
replace_once(
    integration,
    'import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";\n',
    'import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";\nimport { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";\n',
    "catalog repository import",
)
replace_once(
    integration,
    '  it("keeps published starter options immutable", async () => {\n',
    """  it("carries starter options when cloning a published release", async () => {
    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    const cloneId = randomUUID();
    unwrap(
      await catalog.clonePublishedRelease({
        parentReleaseId: fixture.releaseId,
        newReleaseId: cloneId,
        releaseNo: 99n,
        name: "phase5-starter-clone",
      }),
    );

    const cloned = await pool.query<{
      region_id: string;
      form_id: string;
      starter_level: number;
      sort_order: number;
    }>(
      `SELECT region_id, form_id, starter_level, sort_order
       FROM starter_options WHERE content_release_id = $1`,
      [cloneId],
    );
    expect(cloned.rows).toEqual([
      {
        region_id: fixture.regionId,
        form_id: fixture.formId,
        starter_level: 5,
        sort_order: 1,
      },
    ]);
  });

  it("keeps published starter options immutable", async () => {
""",
    "clone integration test",
)

# Fail closed if any lifecycle surface is still missing.
checks = {
    "contracts": ("src/modules/catalog/contracts.ts", "readonly starterOptions:"),
    "fingerprint": ("src/modules/catalog/fingerprint.ts", "starterOptions: sortByCanonical"),
    "diff": ("src/modules/catalog/diff.ts", "starterOptions: snapshot.starterOptions.map"),
    "validation": ("src/modules/catalog/validation.ts", "STARTER_OPTION_REFERENCE_MISSING"),
    "snapshot query": (repo, "FROM starter_options"),
    "clone": (repo, 'table: "starter_options"'),
    "catalog tests": (test, "fingerprinted, validated and diffable content"),
    "clone test": (integration, "carries starter options when cloning a published release"),
}
for label, (path, needle) in checks.items():
    if needle not in read(path):
        raise SystemExit(f"{label}: post-patch verification failed")

print("Phase 5 starter catalog hardening patch staged successfully.")
