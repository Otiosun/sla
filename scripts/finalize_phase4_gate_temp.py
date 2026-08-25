from pathlib import Path

# 1) Database uniqueness: START/TM/TUTOR/EVENT rows use NULL learn_level and must
# still be unique across seed retries.
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

# 2) JSONB key ordering is not an identity contract. Compare parsed objects deeply.
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

# 3) PostgreSQL proof for logical rollback + historical version pinning + immutable published snapshot.
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

# 4) Execute the actual Phase 4 seed twice against a disposable clean database in CI.
ci = Path(".github/workflows/ci.yml")
ci_text = ci.read_text()
step_name = "      - name: Phase 4 vertical slice seed proof\n"
if step_name not in ci_text:
    marker = "      - name: Migrator/runtime privilege separation proof\n"
    if ci_text.count(marker) != 1:
        raise SystemExit("CI insertion marker was not found exactly once")
    step = r'''      - name: Phase 4 vertical slice seed proof
        shell: bash
        run: |
          set -euo pipefail

          seed_db="pokemon_rpg_phase4_seed_test"
          seed_url="postgresql://pokemon:test-only-password@localhost:5432/${seed_db}"

          docker exec pokemon-postgres createdb \
            --username pokemon \
            "$seed_db"

          DATABASE_URL="$seed_url" \
          MIGRATOR_DATABASE_URL="$seed_url" \
          MIGRATION_APPLIED_BY="ci-phase4-seed" \
            pnpm db:migrate

          DATABASE_URL="$seed_url" MIGRATOR_DATABASE_URL="$seed_url" pnpm db:seed:phase4
          DATABASE_URL="$seed_url" MIGRATOR_DATABASE_URL="$seed_url" pnpm db:seed:phase4

          seed_ok="$(docker exec pokemon-postgres psql \
            --username pokemon \
            --dbname "$seed_db" \
            --tuples-only \
            --no-align \
            --command "
              SELECT CASE WHEN
                (SELECT count(*) = 1
                   FROM rulesets
                  WHERE key = 'phase4-core-v1' AND version = 1 AND status = 'PUBLISHED')
                AND (SELECT count(*) = 1
                       FROM content_releases
                      WHERE release_no = 1 AND status = 'PUBLISHED')
                AND (SELECT count(*) = 1
                       FROM content_release_pointers p
                       JOIN content_releases r ON r.id = p.content_release_id
                      WHERE p.pointer_key = 'ACTIVE' AND r.release_no = 1)
                AND (SELECT count(*) = 9
                       FROM pokemon_species_revisions sr
                       JOIN content_releases r ON r.id = sr.content_release_id
                      WHERE r.release_no = 1)
                AND (SELECT count(*) = 8
                       FROM move_revisions mr
                       JOIN content_releases r ON r.id = mr.content_release_id
                      WHERE r.release_no = 1)
                AND (SELECT count(*) = 6
                       FROM ability_revisions ar
                       JOIN content_releases r ON r.id = ar.content_release_id
                      WHERE r.release_no = 1)
                AND (SELECT count(*) = 6
                       FROM item_revisions ir
                       JOIN content_releases r ON r.id = ir.content_release_id
                      WHERE r.release_no = 1)
                AND (SELECT count(*) = 6
                       FROM nature_revisions nr
                       JOIN content_releases r ON r.id = nr.content_release_id
                      WHERE r.release_no = 1)
                AND (SELECT count(*) = 1
                       FROM area_revisions avr
                       JOIN content_releases r ON r.id = avr.content_release_id
                      WHERE r.release_no = 1)
                AND (SELECT count(*) = 3
                       FROM encounter_entries ee
                       JOIN encounter_table_revisions etr ON etr.id = ee.encounter_table_revision_id
                       JOIN content_releases r ON r.id = etr.content_release_id
                      WHERE r.release_no = 1)
              THEN 'ok' ELSE 'bad' END;
            ")"

          test "$seed_ok" = "ok"

'''
    ci_text = ci_text.replace(marker, step + marker, 1)
    ci.write_text(ci_text)
