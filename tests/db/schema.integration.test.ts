import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DatabaseSchemaOutOfDateError,
  MigrationIntegrityError,
  loadMigrations,
  runMigrations,
  verifyAppliedMigrations,
} from "../../src/platform/db/migrations.js";
import { withTransaction } from "../../src/platform/db/transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 12,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
});

interface FixtureCatalog {
  readonly rulesetId: string;
  readonly releaseId: string;
  readonly typeId: string;
  readonly speciesId: string;
  readonly formId: string;
  readonly itemId: string;
  readonly regionId: string;
  readonly areaId: string;
}

async function expectPgCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error code ${expectedCode}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Expected PostgreSQL error code ${expectedCode}`
    ) {
      throw error;
    }
    expect(error).toMatchObject({ code: expectedCode });
  }
}

async function seedCatalog(client: PoolClient): Promise<FixtureCatalog> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const itemId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'test-rules', 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId],
  );
  await client.query(
    `UPDATE rulesets
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "a".repeat(64)],
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
    `UPDATE content_releases
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "b".repeat(64)],
  );
  await client.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [releaseId],
  );
  await client.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'normal')", [typeId]);
  await client.query(
    "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 1, 'bulbasaur')",
    [speciesId],
  );
  await client.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await client.query("INSERT INTO items(id, slug) VALUES ($1, 'poke-ball')", [itemId]);
  await client.query("INSERT INTO regions(id, slug) VALUES ($1, 'kanto')", [regionId]);
  await client.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, 'route-1')", [
    areaId,
    regionId,
  ]);

  return { rulesetId, releaseId, typeId, speciesId, formId, itemId, regionId, areaId };
}

async function createPlayer(client: PoolClient): Promise<string> {
  const playerId = randomUUID();
  await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  return playerId;
}

async function createPokemon(
  client: PoolClient,
  ownerPlayerId: string,
  formId: string,
): Promise<string> {
  const pokemonId = randomUUID();
  await client.query(
    `INSERT INTO pokemon_instances(
       id, owner_player_id, form_id, level, current_hp, origin_type
     ) VALUES ($1, $2, $3, 5, 20, 'TEST')`,
    [pokemonId, ownerPlayerId, formId],
  );
  return pokemonId;
}

async function consumeLastItem(playerId: string, itemId: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE inventory_balances
       SET quantity = quantity - 1, revision = revision + 1, updated_at = now()
       WHERE player_id = $1 AND item_id = $2 AND quantity >= 1
       RETURNING quantity`,
      [playerId, itemId],
    );
    return result.rowCount === 1;
  });
}

async function applyIdempotentInventoryGrant(
  playerId: string,
  itemId: string,
  key: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const ledgerId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO inventory_ledger(
         id, player_id, item_id, delta, source_type, source_id, actor_type,
         idempotency_scope, idempotency_key
       ) VALUES ($1, $2, $3, 5, 'TEST', 'same-source', 'SYSTEM', 'test-grant', $4)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
       RETURNING id`,
      [ledgerId, playerId, itemId, key],
    );

    if (inserted.rowCount !== 1) {
      return false;
    }

    await client.query(
      `INSERT INTO inventory_balances(player_id, item_id, quantity)
       VALUES ($1, $2, 5)
       ON CONFLICT (player_id, item_id)
       DO UPDATE SET quantity = inventory_balances.quantity + 5,
                     revision = inventory_balances.revision + 1,
                     updated_at = now()`,
      [playerId, itemId],
    );
    return true;
  });
}

describe.sequential("PostgreSQL core schema and migration contract", () => {
  let catalog: FixtureCatalog;
  let migrationCount: number;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");

    migrationCount = (await loadMigrations()).length;
    const concurrentRuns = await Promise.all([
      runMigrations(pool, { appliedBy: "vitest-a" }),
      runMigrations(pool, { appliedBy: "vitest-b" }),
    ]);
    expect(concurrentRuns[0]).toHaveLength(migrationCount);
    expect(concurrentRuns[1]).toHaveLength(migrationCount);

    const client = await pool.connect();
    try {
      catalog = await seedCatalog(client);
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  it("requires rulesets and content releases to be created as DRAFT", async () => {
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

  it("rejects lifecycle metadata that does not match DRAFT or VALIDATED state", async () => {
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

  it("applies every migration exactly once and concurrent runners serialize", async () => {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );
    expect(result.rows[0]?.count).toBe(String(migrationCount));

    await runMigrations(pool, { appliedBy: "vitest-repeat" });
    const repeated = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );
    expect(repeated.rows[0]?.count).toBe(String(migrationCount));
  });

  it("fails closed when an applied migration checksum differs", async () => {
    const migrations = await loadMigrations();
    const first = migrations[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const tampered = [{ ...first, checksum: "0".repeat(64) }];
    const client = await pool.connect();
    try {
      await expect(verifyAppliedMigrations(client, tampered, true)).rejects.toBeInstanceOf(
        MigrationIntegrityError,
      );
    } finally {
      client.release();
    }
  });

  it("fails runtime verification when the database is behind expected migrations", async () => {
    const migrations = await loadMigrations();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [migrationCount]);
      await expect(verifyAppliedMigrations(client, migrations, true)).rejects.toBeInstanceOf(
        DatabaseSchemaOutOfDateError,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rolls back transaction helper mutations when work throws", async () => {
    const marker = randomUUID();
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [marker]);
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow(/intentional rollback/);

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM players WHERE id=$1",
      [marker],
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("rejects duplicate external identity", async () => {
    const client = await pool.connect();
    try {
      const playerA = await createPlayer(client);
      const playerB = await createPlayer(client);
      await client.query(
        `INSERT INTO player_identities(id, player_id, provider, external_id, status)
         VALUES ($1, $2, 'whatsapp', '5511999999999', 'ACTIVE')`,
        [randomUUID(), playerA],
      );
      await expectPgCode(
        client.query(
          `INSERT INTO player_identities(id, player_id, provider, external_id, status)
           VALUES ($1, $2, 'whatsapp', '5511999999999', 'ACTIVE')`,
          [randomUUID(), playerB],
        ),
        "23505",
      );
    } finally {
      client.release();
    }
  });

  it("enforces team slots, unique placement and roster ownership", async () => {
    const client = await pool.connect();
    try {
      const playerA = await createPlayer(client);
      const playerB = await createPlayer(client);
      const pokemonA1 = await createPokemon(client, playerA, catalog.formId);
      const pokemonA2 = await createPokemon(client, playerA, catalog.formId);
      const pokemonB = await createPokemon(client, playerB, catalog.formId);

      await expectPgCode(
        client.query(
          `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, slot_no)
           VALUES ($1, $2, 'TEAM', 7)`,
          [pokemonA1, playerA],
        ),
        "23514",
      );

      await client.query(
        `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, slot_no)
         VALUES ($1, $2, 'TEAM', 1)`,
        [pokemonA1, playerA],
      );

      await expectPgCode(
        client.query(
          `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, slot_no)
           VALUES ($1, $2, 'TEAM', 1)`,
          [pokemonA2, playerA],
        ),
        "23505",
      );

      await expectPgCode(
        client.query(
          `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, box_no, slot_no)
           VALUES ($1, $2, 'BOX', 1, 1)`,
          [pokemonA1, playerA],
        ),
        "23505",
      );

      await expectPgCode(
        client.query(
          `INSERT INTO pokemon_roster_slots(pokemon_instance_id, player_id, placement_kind, slot_no)
           VALUES ($1, $2, 'TEAM', 2)`,
          [pokemonB, playerA],
        ),
        "23503",
      );
    } finally {
      client.release();
    }
  });

  it("rejects negative inventory and allows only one concurrent consumer of the last item", async () => {
    const client = await pool.connect();
    let playerId: string;
    try {
      playerId = await createPlayer(client);
      await expectPgCode(
        client.query(
          "INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1, $2, -1)",
          [playerId, catalog.itemId],
        ),
        "23514",
      );
      await client.query(
        "INSERT INTO inventory_balances(player_id, item_id, quantity) VALUES ($1, $2, 1)",
        [playerId, catalog.itemId],
      );
    } finally {
      client.release();
    }

    const outcomes = await Promise.all([
      consumeLastItem(playerId, catalog.itemId),
      consumeLastItem(playerId, catalog.itemId),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const balance = await pool.query<{ quantity: string }>(
      "SELECT quantity::text AS quantity FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
      [playerId, catalog.itemId],
    );
    expect(balance.rows[0]?.quantity).toBe("0");
  });

  it("rejects two incompatible active encounters for one player", async () => {
    const client = await pool.connect();
    try {
      const playerId = await createPlayer(client);
      const values = [
        playerId,
        catalog.areaId,
        catalog.releaseId,
        catalog.rulesetId,
        Buffer.alloc(32, 1),
        Buffer.from("123456789012"),
        Buffer.from("1234567890123456"),
      ];

      await client.query(
        `INSERT INTO encounters(
           id, player_id, area_id, status, content_release_id, ruleset_id,
           rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
         ) VALUES ($1, $2, $3, 'PRESENTED', $4, $5, $6, $7, $8, 1)`,
        [randomUUID(), ...values],
      );

      await expectPgCode(
        client.query(
          `INSERT INTO encounters(
             id, player_id, area_id, status, content_release_id, ruleset_id,
             rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
           ) VALUES ($1, $2, $3, 'CREATED', $4, $5, $6, $7, $8, 1)`,
          [randomUUID(), ...values],
        ),
        "23505",
      );
    } finally {
      client.release();
    }
  });

  it("allows only one resolution to win the same battle version", async () => {
    const battleId = randomUUID();
    await pool.query(
      `INSERT INTO battles(
         id, battle_type, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
       ) VALUES ($1, 'WILD', 'ACTIVE', $2, $3, $4, $5, $6, 1)`,
      [
        battleId,
        catalog.releaseId,
        catalog.rulesetId,
        Buffer.alloc(32, 1),
        Buffer.from("123456789012"),
        Buffer.from("1234567890123456"),
      ],
    );

    const resolve = async () =>
      pool.query(
        `UPDATE battles
         SET version = version + 1, turn_number = turn_number + 1, updated_at = now()
         WHERE id = $1 AND version = 0 AND status = 'ACTIVE'
         RETURNING version`,
        [battleId],
      );

    const results = await Promise.all([resolve(), resolve()]);
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
  });

  it("uses ledger uniqueness as an exactly-once guard under concurrent retries", async () => {
    const client = await pool.connect();
    let playerId: string;
    try {
      playerId = await createPlayer(client);
    } finally {
      client.release();
    }

    const idempotencyKey = randomUUID();
    const outcomes = await Promise.all([
      applyIdempotentInventoryGrant(playerId, catalog.itemId, idempotencyKey),
      applyIdempotentInventoryGrant(playerId, catalog.itemId, idempotencyKey),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const balance = await pool.query<{ quantity: string }>(
      "SELECT quantity::text AS quantity FROM inventory_balances WHERE player_id=$1 AND item_id=$2",
      [playerId, catalog.itemId],
    );
    expect(balance.rows[0]?.quantity).toBe("5");

    const ledger = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_ledger
       WHERE idempotency_scope='test-grant' AND idempotency_key=$1`,
      [idempotencyKey],
    );
    expect(ledger.rows[0]?.count).toBe("1");
  });

  it("persists required input correlation and rejects uncorrelated inbox rows", async () => {
    const correlationId = randomUUID();
    await pool.query(
      `INSERT INTO inbox_messages(
         id, provider, external_message_id, payload_hash, status, correlation_id
       ) VALUES ($1, 'whatsapp', $2, 'sha256:test', 'RECEIVED', $3)`,
      [randomUUID(), randomUUID(), correlationId],
    );

    const persisted = await pool.query<{ correlation_id: string }>(
      "SELECT correlation_id FROM inbox_messages WHERE correlation_id=$1",
      [correlationId],
    );
    expect(persisted.rows[0]?.correlation_id).toBe(correlationId);

    await expectPgCode(
      pool.query(
        `INSERT INTO inbox_messages(
           id, provider, external_message_id, payload_hash, status
         ) VALUES ($1, 'whatsapp', $2, 'sha256:test', 'RECEIVED')`,
        [randomUUID(), randomUUID()],
      ),
      "23502",
    );
  });

  it("keeps outbox retries separate from mechanics and preserves causality", async () => {
    const key = randomUUID();
    const outboxId = randomUUID();
    const correlationId = randomUUID();
    const causationId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key, status,
         correlation_id, causation_id
       ) VALUES ($1, 'whatsapp', 'test-destination', 'TEXT', '{}'::jsonb, $2, 'PENDING', $3, $4)`,
      [outboxId, key, correlationId, causationId],
    );

    await expectPgCode(
      pool.query(
        `INSERT INTO outbox_messages(
           id, channel, destination_ref, message_type, payload, idempotency_key, status,
           correlation_id, causation_id
         ) VALUES ($1, 'whatsapp', 'test-destination', 'TEXT', '{}'::jsonb, $2, 'PENDING', $3, $4)`,
        [randomUUID(), key, correlationId, causationId],
      ),
      "23505",
    );

    await pool.query(
      `UPDATE outbox_messages
       SET status='FAILED', attempts=attempts+1, next_attempt_at=now()
       WHERE id=$1`,
      [outboxId],
    );
    await pool.query(
      `UPDATE outbox_messages
       SET status='SENT', attempts=attempts+1, sent_at=now(), next_attempt_at=NULL
       WHERE id=$1`,
      [outboxId],
    );

    const row = await pool.query<{
      attempts: number;
      causation_id: string;
      correlation_id: string;
      status: string;
    }>(
      `SELECT attempts, causation_id, correlation_id, status
       FROM outbox_messages WHERE id=$1`,
      [outboxId],
    );
    expect(row.rows[0]).toMatchObject({
      attempts: 2,
      causation_id: causationId,
      correlation_id: correlationId,
      status: "SENT",
    });
  });

  it("enforces caught_count <= seen_count", async () => {
    const client = await pool.connect();
    try {
      const playerId = await createPlayer(client);
      await expectPgCode(
        client.query(
          `INSERT INTO player_pokedex_species(player_id, species_id, seen_count, caught_count)
           VALUES ($1, $2, 0, 1)`,
          [playerId, catalog.speciesId],
        ),
        "23514",
      );
    } finally {
      client.release();
    }
  });

  it("requires active effects to target exactly one supported entity", async () => {
    const effectId = randomUUID();
    await pool.query("INSERT INTO effects(id, slug) VALUES ($1, $2)", [
      effectId,
      `effect-${effectId}`,
    ]);
    const client = await pool.connect();
    try {
      const playerId = await createPlayer(client);
      await expectPgCode(
        client.query(
          `INSERT INTO active_effects(
             id, effect_id, content_release_id, source_type, source_id
           ) VALUES ($1, $2, $3, 'TEST', 'source')`,
          [randomUUID(), effectId, catalog.releaseId],
        ),
        "23514",
      );
      await client.query(
        `INSERT INTO active_effects(
           id, effect_id, content_release_id, player_id, source_type, source_id
         ) VALUES ($1, $2, $3, $4, 'TEST', 'source')`,
        [randomUUID(), effectId, catalog.releaseId, playerId],
      );
    } finally {
      client.release();
    }
  });

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
    await pool.query("UPDATE content_releases SET status = 'ARCHIVED' WHERE id = $1", [
      newReleaseId,
    ]);

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
});
