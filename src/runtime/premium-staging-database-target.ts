/**
 * Canonical provider identity observed for the Pokémon staging RC Supabase
 * project. A production URL must never become eligible merely because an
 * operator labels an environment "staging".
 *
 * This parser is a *pre-connection* safety gate, not proof of network or
 * database role isolation. A human must audit the underlying Supabase grants.
 */
export const PREMIUM_STAGING_SUPABASE_REF = "rfskcoaoppfrcdmqtvvj";

export function isApprovedPremiumStagingDatabaseUrl(value: string): boolean {
  try {
    const uri = new URL(value);
    if (uri.protocol !== "postgresql:" && uri.protocol !== "postgres:") return false;
    if (uri.port !== "5432" || uri.pathname !== "/postgres" || uri.hash) return false;
    if (uri.searchParams.getAll("sslmode").length !== 1 ||
        uri.searchParams.get("sslmode") !== "verify-full") return false;

    const direct =
      uri.hostname === `db.${PREMIUM_STAGING_SUPABASE_REF}.supabase.co` &&
      decodeURIComponent(uri.username) === "pokemon_runtime";
    const sessionPooler =
      /^aws-[0-9]+-sa-east-1\.pooler\.supabase\.com$/.test(uri.hostname) &&
      decodeURIComponent(uri.username) === `pokemon_runtime.${PREMIUM_STAGING_SUPABASE_REF}`;

    // Reject transaction pooler :6543 and any prod/other Supabase project.
    return direct || sessionPooler;
  } catch {
    return false;
  }
}
