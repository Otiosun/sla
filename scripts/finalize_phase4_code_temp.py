from pathlib import Path

migration = Path("db/migrations/0003_catalog_release_lifecycle.sql")
sql = migration.read_text()
old_unique = "UNIQUE (content_release_id, form_id, move_id, learn_method, learn_level),"
new_unique = "UNIQUE NULLS NOT DISTINCT (content_release_id, form_id, move_id, learn_method, learn_level),"
if old_unique in sql:
    if sql.count(old_unique) != 1:
        raise SystemExit("Unexpected learnset uniqueness occurrence count")
    sql = sql.replace(old_unique, new_unique)
elif new_unique not in sql:
    raise SystemExit("Learnset uniqueness constraint was not found")
migration.write_text(sql)

seed = Path("db/seeds/phase4_vertical_slice.ts")
seed_text = seed.read_text()
util_import = 'import { isDeepStrictEqual } from "node:util";\n'
if util_import not in seed_text:
    seed_text = seed_text.replace(
        'import { randomUUID } from "node:crypto";\n',
        'import { randomUUID } from "node:crypto";\n' + util_import,
        1,
    )
old_compare = "if (JSON.stringify(row.config) !== JSON.stringify(RULESET_CONFIG)) {"
new_compare = "if (!isDeepStrictEqual(row.config, RULESET_CONFIG)) {"
if old_compare in seed_text:
    seed_text = seed_text.replace(old_compare, new_compare, 1)
elif new_compare not in seed_text:
    raise SystemExit("Ruleset config comparison was not found")
seed.write_text(seed_text)

test = Path("tests/db/schema.integration.test.ts")
test_text = test.read_text()
test_name = 'it("supports logical release rollback while historical battles stay pinned"'
if test_name not in test_text:
    block = r'''

  it("supports logical release rollback while historical battles stay pinned", async () => {
    const newReleaseId = randomUUID();
    const battleId = randomUUID();

    await pool.query(
      `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
       VALUES ($1, 900001, 'rollback-target', 'DRAFT', $2)`,
      [newReleaseId, catalog.rulesetId],
    );
    await pool.query(
      `UPDATE content_releases
       SET status = 'VALIDATED',
           validated_at = now(),
           validation_report = '{"valid":true,"issues":[]}'::jsonb,
           content_fingerprint = $2
       WHERE id = $1`,
      [newReleaseId, "b".repeat(64)],
    );
    await pool.query(
      `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
      [newReleaseId],
    );

    await pool.query(
      `INSERT INTO content_release_pointers(pointer_key, content_release_id)
       VALUES ('ACTIVE', $1)
       ON CONFLICT (pointer_key)
       DO UPDATE SET content_release_id = EXCLUDED.content_release_id,
                     revision = content_release_pointers.revision + 1,
                     updated_at = now()`,
      [catalog.releaseId],
    );

    await pool.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
       ) VALUES ($1, 'WILD', 'CREATED', $2, $3, $4, $5, $6, 1)`,
      [
        battleId,
        catalog.releaseId,
        catalog.rulesetId,
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.alloc(16, 3),
      ],
    );

    await pool.query(
      `UPDATE content_release_pointers
       SET content_release_id = $1,
           revision = revision + 1,
           updated_at = now()
       WHERE pointer_key = 'ACTIVE'`,
      [newReleaseId],
    );

    const switched = await pool.query<{
      battle_release_id: string;
      pointer_release_id: string;
    }>(
      `SELECT b.content_release_id AS battle_release_id,
              p.content_release_id AS pointer_release_id
       FROM battles b
       CROSS JOIN content_release_pointers p
       WHERE b.id = $1 AND p.pointer_key = 'ACTIVE'`,
      [battleId],
    );
    expect(switched.rows[0]).toEqual({
      battle_release_id: catalog.releaseId,
      pointer_release_id: newReleaseId,
    });

    await expectPgCode(
      pool.query(
        `INSERT INTO pokemon_type_revisions(
           id, content_release_id, type_id, display_name
         ) VALUES ($1, $2, $3, 'illegal-published-mutation')`,
        [randomUUID(), catalog.releaseId, catalog.typeId],
      ),
      "55000",
    );

    await pool.query(
      `UPDATE content_release_pointers
       SET content_release_id = $1,
           revision = revision + 1,
           updated_at = now()
       WHERE pointer_key = 'ACTIVE'`,
      [catalog.releaseId],
    );
    await pool.query("UPDATE content_releases SET status = 'ARCHIVED' WHERE id = $1", [newReleaseId]);

    const rolledBack = await pool.query<{
      battle_release_id: string;
      archived_status: string;
      pointer_release_id: string;
    }>(
      `SELECT b.content_release_id AS battle_release_id,
              archived.status AS archived_status,
              p.content_release_id AS pointer_release_id
       FROM battles b
       CROSS JOIN content_release_pointers p
       JOIN content_releases archived ON archived.id = $2
       WHERE b.id = $1 AND p.pointer_key = 'ACTIVE'`,
      [battleId, newReleaseId],
    );
    expect(rolledBack.rows[0]).toEqual({
      battle_release_id: catalog.releaseId,
      archived_status: "ARCHIVED",
      pointer_release_id: catalog.releaseId,
    });
  });
'''
    closing = "\n});\n"
    if not test_text.endswith(closing):
        raise SystemExit("Unexpected schema integration test ending")
    test_text = test_text[: -len(closing)] + block + closing
    test.write_text(test_text)
