import type { Pool } from "pg";
import { PostgresExpeditionReadOnlyMenuIssuer } from "./postgres-expedition-readonly-menu-issuer.js";

/**
 * Explicit offline test entrypoint to the canonical transactional issuer.
 * The base class itself blocks ACTIONABLE outside APP_ENV=test,
 * NODE_ENV=test and WHATSAPP_ENABLED=false. Not registered in live runtime.
 */
export class PostgresExpeditionOfflineActionableMenuIssuer extends PostgresExpeditionReadOnlyMenuIssuer {
  constructor(pool: Pool, combiningCount = 0) {
    super(pool, "ACTIONABLE", combiningCount);
  }
}
