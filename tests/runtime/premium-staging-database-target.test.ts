import { describe, expect, it } from "vitest";
import {
  PREMIUM_STAGING_SUPABASE_REF,
  isApprovedPremiumStagingDatabaseUrl,
} from "../../src/runtime/premium-staging-database-target.js";

const ref = PREMIUM_STAGING_SUPABASE_REF;
const pool = "aws-0-sa-east-1.pooler.supabase.com";
const direct = `db.${ref}.supabase.co`;
const url = (host: string, user: string, port = 5432, query = "sslmode=verify-full") =>
  `postgresql://${user}@${host}:${port}/postgres?${query}`;

describe("Premium staging DB target is pinned before a connection is opened", () => {
  it("accepts only the staging project and least-privileged app role", () => {
    expect(isApprovedPremiumStagingDatabaseUrl(url(pool, `pokemon_runtime.${ref}`))).toBe(true);
    expect(isApprovedPremiumStagingDatabaseUrl(url(direct, "pokemon_runtime"))).toBe(true);
  });

  it("rejects production/foreign tenants, administrative roles, and pooler substitutes", () => {
    const otherRef = "aaaaaaaaaaaaaaaaaaaa";
    for (const value of [
      url(pool, `pokemon_runtime.${otherRef}`),
      url(`db.${otherRef}.supabase.co`, "pokemon_runtime"),
      url(pool, `postgres.${ref}`),
      url(pool, `pokemon_migrator.${ref}`),
      url(direct, "postgres"),
      url(pool, `pokemon_runtime.${ref}`, 6543),
      url(pool, `pokemon_runtime.${ref}`, 5432, "sslmode=require"),
      url(pool, `pokemon_runtime.${ref}`, 5432, "sslmode=verify-full&sslmode=require"),
      url("aws-0-us-east-1.pooler.supabase.com", `pokemon_runtime.${ref}`),
      url(`db.${ref}.supabase.co.evil.invalid`, "pokemon_runtime"),
      `postgresql://pokemon_runtime.${ref}@${pool}:5432/other?sslmode=verify-full`,
      "not-a-database-url",
    ]) {
      expect(isApprovedPremiumStagingDatabaseUrl(value), value).toBe(false);
    }
  });
});
