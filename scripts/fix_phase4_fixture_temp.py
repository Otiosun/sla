from pathlib import Path

path = Path("tests/db/schema.integration.test.ts")
text = path.read_text()

old_ruleset = """  await client.query(
    `UPDATE rulesets SET status = 'VALIDATED', validated_at = now() WHERE id = $1`,
    [rulesetId],
  );
"""
new_ruleset = """  await client.query(
    `UPDATE rulesets
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{\"valid\":true,\"issues\":[]}'::jsonb,
         config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, \"a\".repeat(64)],
  );
"""
if old_ruleset in text:
    text = text.replace(old_ruleset, new_ruleset, 1)
elif new_ruleset not in text:
    raise SystemExit("ruleset fixture transition not found")

old_release = """  await client.query(
    `UPDATE content_releases SET status = 'VALIDATED', validated_at = now() WHERE id = $1`,
    [releaseId],
  );
"""
new_release = """  await client.query(
    `UPDATE content_releases
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{\"valid\":true,\"issues\":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, \"b\".repeat(64)],
  );
"""
if old_release in text:
    text = text.replace(old_release, new_release, 1)
elif new_release not in text:
    raise SystemExit("release fixture transition not found")

path.write_text(text)
