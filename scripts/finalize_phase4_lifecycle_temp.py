from pathlib import Path

migration = Path("db/migrations/0003_catalog_release_lifecycle.sql")
sql = migration.read_text()

old_ruleset_checks = """ALTER TABLE rulesets
  ADD CONSTRAINT rulesets_validated_timestamp_check
  CHECK (status = 'DRAFT' OR validated_at IS NOT NULL),
  ADD CONSTRAINT rulesets_published_timestamp_check
  CHECK (status NOT IN ('PUBLISHED', 'ARCHIVED') OR published_at IS NOT NULL);
"""
new_ruleset_checks = """ALTER TABLE rulesets
  ADD CONSTRAINT rulesets_lifecycle_metadata_check
  CHECK (
    (status = 'DRAFT'
      AND validated_at IS NULL
      AND validation_report IS NULL
      AND config_fingerprint IS NULL
      AND published_at IS NULL)
    OR (status = 'VALIDATED'
      AND validated_at IS NOT NULL
      AND validation_report IS NOT NULL
      AND config_fingerprint IS NOT NULL
      AND published_at IS NULL)
    OR (status IN ('PUBLISHED', 'ARCHIVED')
      AND validated_at IS NOT NULL
      AND validation_report IS NOT NULL
      AND published_at IS NOT NULL
      AND (
        config_fingerprint IS NOT NULL
        OR validation_report ->> 'legacy_backfill' = 'true'
      ))
  );
"""
if old_ruleset_checks in sql:
    sql = sql.replace(old_ruleset_checks, new_ruleset_checks, 1)
elif new_ruleset_checks not in sql:
    raise SystemExit("ruleset lifecycle metadata block not found")

old_release_checks = """ALTER TABLE content_releases
  ADD CONSTRAINT content_releases_validated_timestamp_check
  CHECK (status = 'DRAFT' OR validated_at IS NOT NULL),
  ADD CONSTRAINT content_releases_published_timestamp_check
  CHECK (status NOT IN ('PUBLISHED', 'ARCHIVED') OR published_at IS NOT NULL);
"""
new_release_checks = """ALTER TABLE content_releases
  ADD CONSTRAINT content_releases_lifecycle_metadata_check
  CHECK (
    (status = 'DRAFT'
      AND validated_at IS NULL
      AND validation_report IS NULL
      AND content_fingerprint IS NULL
      AND published_at IS NULL)
    OR (status = 'VALIDATED'
      AND validated_at IS NOT NULL
      AND validation_report IS NOT NULL
      AND content_fingerprint IS NOT NULL
      AND published_at IS NULL)
    OR (status IN ('PUBLISHED', 'ARCHIVED')
      AND validated_at IS NOT NULL
      AND validation_report IS NOT NULL
      AND published_at IS NOT NULL
      AND (
        content_fingerprint IS NOT NULL
        OR validation_report ->> 'legacy_backfill' = 'true'
      ))
  );
"""
if old_release_checks in sql:
    sql = sql.replace(old_release_checks, new_release_checks, 1)
elif new_release_checks not in sql:
    raise SystemExit("content release lifecycle metadata block not found")

migration.write_text(sql)

unit = Path("tests/catalog/catalog-contracts.test.ts")
unit_text = unit.read_text()
old_first = """    const invalid: CatalogSnapshotWithEffects = {
      ...snapshot,
      moves: [
        {
          ...snapshot.moves[0]!,
          effectKey: \"javascript\",
          effectConfig: { source: \"process.exit()\" },
        },
      ],
    };
"""
new_first = """    const firstMove = snapshot.moves[0];
    expect(firstMove).toBeDefined();
    if (firstMove === undefined) return;

    const invalid: CatalogSnapshotWithEffects = {
      ...snapshot,
      moves: [
        {
          ...firstMove,
          effectKey: \"javascript\",
          effectConfig: { source: \"process.exit()\" },
        },
      ],
    };
"""
if old_first in unit_text:
    unit_text = unit_text.replace(old_first, new_first, 1)
elif new_first not in unit_text:
    raise SystemExit("first non-null assertion block not found")

old_second = """    const after: CatalogSnapshotWithEffects = {
      ...validSnapshot(\"release-2\"),
      release: {
        ...validSnapshot(\"release-2\").release,
        parentReleaseId: \"release-1\",
      },
      moves: [{ ...before.moves[0]!, power: 50 }],
    };
"""
new_second = """    const beforeMove = before.moves[0];
    expect(beforeMove).toBeDefined();
    if (beforeMove === undefined) return;

    const after: CatalogSnapshotWithEffects = {
      ...validSnapshot(\"release-2\"),
      release: {
        ...validSnapshot(\"release-2\").release,
        parentReleaseId: \"release-1\",
      },
      moves: [{ ...beforeMove, power: 50 }],
    };
"""
if old_second in unit_text:
    unit_text = unit_text.replace(old_second, new_second, 1)
elif new_second not in unit_text:
    raise SystemExit("second non-null assertion block not found")

unit.write_text(unit_text)

integration = Path("tests/db/schema.integration.test.ts")
integration_text = integration.read_text()
marker = """  it(\"applies every migration exactly once and concurrent runners serialize\", async () => {
"""
new_test_name = 'it("rejects lifecycle metadata that does not match DRAFT or VALIDATED state"'
if new_test_name not in integration_text:
    test_block = r'''  it("rejects lifecycle metadata that does not match DRAFT or VALIDATED state", async () => {
    const draftRulesetId = randomUUID();
    await expectPgCode(
      pool.query(
        `INSERT INTO rulesets(
           id, key, version, engine_contract_version, config, status, validated_at,
           validation_report, config_fingerprint
         ) VALUES ($1, $2, 1001, 1, '{}'::jsonb, 'DRAFT', now(), '{}'::jsonb, $3)`,
        [draftRulesetId, `draft-metadata-${draftRulesetId}`, "a".repeat(64)],
      ),
      "23514",
    );

    const validatingRulesetId = randomUUID();
    await pool.query(
      `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
       VALUES ($1, $2, 1002, 1, '{}'::jsonb, 'DRAFT')`,
      [validatingRulesetId, `validated-metadata-${validatingRulesetId}`],
    );
    await expectPgCode(
      pool.query(
        `UPDATE rulesets
         SET status = 'VALIDATED', validated_at = now(), validation_report = '{}'::jsonb
         WHERE id = $1`,
        [validatingRulesetId],
      ),
      "23514",
    );

    const draftReleaseId = randomUUID();
    await expectPgCode(
      pool.query(
        `INSERT INTO content_releases(
           id, release_no, name, status, default_ruleset_id, validated_at,
           validation_report, content_fingerprint
         ) VALUES ($1, 999998, 'draft-metadata', 'DRAFT', $2, now(), '{}'::jsonb, $3)`,
        [draftReleaseId, catalog.rulesetId, "b".repeat(64)],
      ),
      "23514",
    );

    const validatingReleaseId = randomUUID();
    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 999997, 'validated-metadata', 'DRAFT', $2)`,
      [validatingReleaseId, catalog.rulesetId],
    );
    await expectPgCode(
      pool.query(
        `UPDATE content_releases
         SET status = 'VALIDATED', validated_at = now(), validation_report = '{}'::jsonb
         WHERE id = $1`,
        [validatingReleaseId],
      ),
      "23514",
    );
  });

'''
    if marker not in integration_text:
        raise SystemExit("integration insertion marker not found")
    integration_text = integration_text.replace(marker, test_block + marker, 1)

integration.write_text(integration_text)
