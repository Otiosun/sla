from pathlib import Path

migration = Path("db/migrations/0003_catalog_release_lifecycle.sql")
sql = migration.read_text()

ruleset_old = """CREATE OR REPLACE FUNCTION guard_ruleset_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN"""
ruleset_new = """CREATE OR REPLACE FUNCTION guard_ruleset_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'rulesets must be created as DRAFT' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN"""

release_old = """CREATE OR REPLACE FUNCTION guard_content_release_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN"""
release_new = """CREATE OR REPLACE FUNCTION guard_content_release_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'content releases must be created as DRAFT' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN"""

for old, new in (
    (ruleset_old, ruleset_new),
    (release_old, release_new),
    ("BEFORE UPDATE OR DELETE ON rulesets", "BEFORE INSERT OR UPDATE OR DELETE ON rulesets"),
    (
        "BEFORE UPDATE OR DELETE ON content_releases",
        "BEFORE INSERT OR UPDATE OR DELETE ON content_releases",
    ),
):
    if sql.count(old) != 1:
        raise SystemExit(f"Expected migration fragment exactly once: {old[:80]!r}")
    sql = sql.replace(old, new)

migration.write_text(sql)

test = Path("tests/db/schema.integration.test.ts")
text = test.read_text()
old_fixture = """  await client.query(
    `INSERT INTO rulesets(
       id, key, version, engine_contract_version, config, status, validated_at, published_at
     ) VALUES ($1, 'test-rules', 1, 1, '{}'::jsonb, 'PUBLISHED', now(), now())`,
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(
       id, release_no, name, status, default_ruleset_id, validated_at, published_at
     ) VALUES ($1, 1, 'test-release', 'PUBLISHED', $2, now(), now())`,
    [releaseId, rulesetId],
  );"""
new_fixture = """  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'test-rules', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now() WHERE id = $1`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [rulesetId],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 1, 'test-release', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now() WHERE id = $1`,
    [releaseId],
  );
  await client.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [releaseId],
  );"""
if text.count(old_fixture) != 1:
    raise SystemExit("Expected current lifecycle fixture exactly once")
text = text.replace(old_fixture, new_fixture)

marker = '  it("applies every migration exactly once and concurrent runners serialize", async () => {'
regression = """  it("requires rulesets and content releases to be created as DRAFT", async () => {
    await expectPgCode(
      pool.query(
        `INSERT INTO rulesets(
           id, key, version, engine_contract_version, config, status, validated_at, published_at
         ) VALUES ($1, $2, 999, 1, '{}'::jsonb, 'PUBLISHED', now(), now())`,
        [randomUUID(), `direct-publish-${randomUUID()}`],
      ),
      "55000",
    );

    await expectPgCode(
      pool.query(
        `INSERT INTO content_releases(
           id, release_no, name, status, default_ruleset_id, validated_at, published_at
         ) VALUES ($1, 999999, 'direct-publish', 'PUBLISHED', $2, now(), now())`,
        [randomUUID(), catalog.rulesetId],
      ),
      "55000",
    );
  });

"""
if text.count(marker) != 1:
    raise SystemExit("Expected integration-test insertion marker exactly once")
text = text.replace(marker, regression + marker)
test.write_text(text)
