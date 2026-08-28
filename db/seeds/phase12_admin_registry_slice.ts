import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const capabilities = [
  ["player.read", 0],
  ["player.read_sensitive", 0],
  ["pokemon.read", 0],
  ["inventory.read", 0],
  ["economy.read", 0],
  ["progression.read", 0],
  ["pokedex.read", 0],
  ["world.read", 0],
  ["battle.read", 0],
  ["effects.read", 0],
  ["audit.read", 0],
  ["admin_operation.read", 0],
  ["player.profile.edit", 1],
  ["player.location.correct", 1],
  ["player.onboarding.support", 1],
  ["pokemon.roster.manage", 1],
  ["encounter.support", 1],
  ["battle.support", 1],
  ["progression.adjust", 2],
  ["progression.unlock.manage", 2],
  ["inventory.adjust", 2],
  ["wallet.adjust", 2],
  ["reward.grant", 2],
  ["effect.apply", 2],
  ["effect.remove", 2],
  ["pokemon.create", 3],
  ["pokemon.edit.basic", 3],
  ["pokemon.edit.mechanics", 3],
  ["pokemon.moves.edit", 3],
  ["pokemon.training.edit", 3],
  ["pokemon.ability.edit", 3],
  ["pokemon.transfer", 3],
  ["pokemon.archive_remove", 3],
  ["pokemon.restore", 3],
  ["pokedex.correct", 3],
  ["encounter.force_close", 3],
  ["battle.force_cancel", 3],
  ["battle.correct_state", 3],
  ["content.draft.create", 3],
  ["content.draft.edit", 3],
  ["content.validate", 3],
  ["content.archive", 3],
  ["batch.preview", 2],
  ["batch.execute.low_risk", 3],
  ["admin_operation.compensate", 3],
  ["player.reset.full", 4],
  ["content.publish", 4],
  ["content.rollback_release", 4],
  ["batch.execute.high_risk", 4],
  ["admin.role.assign", 4],
  ["admin.role.manage", 4],
  ["admin.capability.manage", 4],
  ["admin.override.invariant", 4],
] as const;

const roles: Record<string, readonly string[]> = {
  SUPPORT: [
    "player.read",
    "pokemon.read",
    "inventory.read",
    "economy.read",
    "progression.read",
    "pokedex.read",
    "world.read",
    "battle.read",
    "effects.read",
    "player.profile.edit",
    "player.location.correct",
    "player.onboarding.support",
    "pokemon.roster.manage",
    "encounter.support",
    "battle.support",
  ],
  GAME_MASTER: [
    "player.read",
    "pokemon.read",
    "inventory.read",
    "progression.read",
    "world.read",
    "battle.read",
    "effects.read",
    "encounter.support",
    "battle.support",
    "reward.grant",
    "effect.apply",
    "effect.remove",
  ],
  ECONOMY_ADMIN: [
    "player.read",
    "inventory.read",
    "economy.read",
    "progression.read",
    "inventory.adjust",
    "wallet.adjust",
    "progression.adjust",
    "progression.unlock.manage",
    "batch.preview",
    "batch.execute.low_risk",
  ],
  POKEMON_ADMIN: [
    "player.read",
    "pokemon.read",
    "pokemon.create",
    "pokemon.edit.basic",
    "pokemon.edit.mechanics",
    "pokemon.moves.edit",
    "pokemon.training.edit",
    "pokemon.ability.edit",
    "pokemon.roster.manage",
    "pokemon.transfer",
    "pokemon.archive_remove",
    "pokemon.restore",
    "pokedex.correct",
  ],
  CONTENT_EDITOR: ["content.draft.create", "content.draft.edit", "content.validate"],
  CONTENT_PUBLISHER: ["content.validate", "content.publish", "content.archive"],
  SENIOR_ADMIN: capabilities.filter(([, risk]) => risk <= 3).map(([key]) => key),
  OWNER_SECURITY_ADMIN: capabilities.map(([key]) => key),
};

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
try {
  for (const [key, riskTier] of capabilities) {
    await pool.query(
      `INSERT INTO capabilities(id, key, risk_tier)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
       SET risk_tier = EXCLUDED.risk_tier
       WHERE capabilities.risk_tier = EXCLUDED.risk_tier`,
      [randomUUID(), key, riskTier],
    );
    const persisted = await pool.query<{ risk_tier: number }>(
      `SELECT risk_tier FROM capabilities WHERE key = $1`,
      [key],
    );
    if (persisted.rows[0]?.risk_tier !== riskTier) {
      throw new Error(`Capability risk drift for ${key}`);
    }
  }

  for (const [slug, capabilityKeys] of Object.entries(roles)) {
    await pool.query(
      `INSERT INTO admin_roles(id, slug, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [randomUUID(), slug, slug.replaceAll("_", " ")],
    );
    const role = await pool.query<{ id: string }>(`SELECT id FROM admin_roles WHERE slug = $1`, [
      slug,
    ]);
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) throw new Error(`Role missing after seed: ${slug}`);
    await pool.query(
      `DELETE FROM admin_role_capabilities relation
       USING capabilities capability
       WHERE relation.role_id = $1
         AND relation.capability_id = capability.id
         AND NOT (capability.key = ANY($2::text[]))`,
      [roleId, capabilityKeys],
    );
    for (const capabilityKey of capabilityKeys) {
      await pool.query(
        `INSERT INTO admin_role_capabilities(role_id, capability_id)
         SELECT $1, capability.id FROM capabilities capability WHERE capability.key = $2
         ON CONFLICT DO NOTHING`,
        [roleId, capabilityKey],
      );
    }
  }
  console.log(
    `Phase 12 admin registry seed ready: ${capabilities.length} capabilities, ${Object.keys(roles).length} roles`,
  );
} finally {
  await pool.end();
}
