import type { Pool } from "pg";
import { OWNER_SECURITY_ADMIN_ROLE } from "../modules/admin/registry-catalog.js";
import { assertDatabaseSchemaCurrent } from "../platform/db/migrations.js";

export interface PostDeployApplicationSmokeInput {
  readonly environment: "staging" | "production";
  readonly deploymentRevision: string;
  readonly whatsappSessionKey: string;
  readonly criticalQueueAgeMs?: number;
  readonly criticalQueueDepth?: number;
}

export interface PostDeployApplicationSmokeReport {
  readonly passed: boolean;
  readonly environment: "staging" | "production";
  readonly deploymentRevision: string;
  readonly schemaCurrent: boolean;
  readonly activeRelease: {
    readonly releaseNo: string;
    readonly releaseStatus: string;
    readonly rulesetStatus: string;
  } | null;
  readonly initialAdmin: {
    readonly environment: string;
    readonly principalStatus: string;
    readonly roleSlug: string;
    readonly globalScopeActive: boolean;
  } | null;
  readonly whatsappSession: {
    readonly present: boolean;
    readonly revision: string | null;
  };
  readonly outbox: {
    readonly deadCount: number;
    readonly unsentCount: number;
    readonly oldestUnsentAgeMs: number;
    readonly criticalQueueAgeMs: number;
    readonly criticalQueueDepth: number;
  };
  readonly providerLiveHealth: "NOT_PROBED";
  readonly finalPostDeploySmokeComplete: false;
  readonly failures: readonly string[];
}

interface ActiveReleaseRow {
  readonly release_no: string;
  readonly release_status: string;
  readonly ruleset_status: string;
}

interface InitialAdminRow {
  readonly environment: string;
  readonly principal_status: string;
  readonly role_slug: string;
  readonly global_scope_active: boolean;
}

interface SessionRow {
  readonly revision: string;
}

interface OutboxRow {
  readonly dead_count: number;
  readonly unsent_count: number;
  readonly oldest_unsent_age_ms: string;
}

const DEFAULT_CRITICAL_QUEUE_AGE_MS = 300_000;
const DEFAULT_CRITICAL_QUEUE_DEPTH = 500;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SESSION_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function positiveThreshold(
  label: string,
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

export async function runPostDeployApplicationSmoke(
  pool: Pool,
  input: PostDeployApplicationSmokeInput,
): Promise<PostDeployApplicationSmokeReport> {
  if (!FULL_SHA.test(input.deploymentRevision)) {
    throw new Error("deploymentRevision must be a full lowercase 40-character Git SHA");
  }
  if (!SESSION_KEY.test(input.whatsappSessionKey)) {
    throw new Error("whatsappSessionKey is invalid");
  }
  const criticalQueueAgeMs = positiveThreshold(
    "criticalQueueAgeMs",
    input.criticalQueueAgeMs,
    DEFAULT_CRITICAL_QUEUE_AGE_MS,
  );
  const criticalQueueDepth = positiveThreshold(
    "criticalQueueDepth",
    input.criticalQueueDepth,
    DEFAULT_CRITICAL_QUEUE_DEPTH,
  );

  await assertDatabaseSchemaCurrent(pool);

  const activeReleaseResult = await pool.query<ActiveReleaseRow>(
    `SELECT
       release.release_no::text AS release_no,
       release.status AS release_status,
       ruleset.status AS ruleset_status
     FROM content_release_pointers AS pointer
     JOIN content_releases AS release ON release.id = pointer.content_release_id
     JOIN rulesets AS ruleset ON ruleset.id = release.default_ruleset_id
     WHERE pointer.pointer_key = 'ACTIVE'`,
  );
  const activeRelease = activeReleaseResult.rows[0] ?? null;

  const initialAdminResult = await pool.query<InitialAdminRow>(
    `SELECT
       bootstrap.environment,
       principal.status AS principal_status,
       role.slug AS role_slug,
       EXISTS (
         SELECT 1
         FROM admin_principal_scopes AS scope
         WHERE scope.principal_id = bootstrap.principal_id
           AND scope.scope_type = 'GLOBAL'
           AND scope.scope_id IS NULL
           AND scope.status = 'ACTIVE'
       ) AS global_scope_active
     FROM admin_initial_bootstrap_state AS bootstrap
     JOIN admin_principals AS principal ON principal.id = bootstrap.principal_id
     JOIN admin_roles AS role ON role.id = bootstrap.role_id
     WHERE bootstrap.singleton_key = 'INITIAL_ADMIN'`,
  );
  const initialAdmin = initialAdminResult.rows[0] ?? null;

  const sessionResult = await pool.query<SessionRow>(
    `SELECT revision::text AS revision
     FROM whatsapp_auth_sessions
     WHERE session_key = $1`,
    [input.whatsappSessionKey],
  );
  const session = sessionResult.rows[0] ?? null;

  const outboxResult = await pool.query<OutboxRow>(
    `SELECT
       count(*) FILTER (WHERE status = 'DEAD')::integer AS dead_count,
       count(*) FILTER (WHERE status IN ('PENDING', 'FAILED', 'SENDING'))::integer AS unsent_count,
       COALESCE(
         floor(
           extract(
             epoch FROM (
               clock_timestamp() - min(created_at) FILTER (
                 WHERE status IN ('PENDING', 'FAILED', 'SENDING')
               )
             )
           ) * 1000
         )::bigint,
         0::bigint
       )::text AS oldest_unsent_age_ms
     FROM outbox_messages`,
  );
  const outbox = outboxResult.rows[0];
  if (outbox === undefined) throw new Error("Outbox smoke query returned no aggregate row");
  const oldestUnsentAgeMs = Number(outbox.oldest_unsent_age_ms);
  if (!Number.isSafeInteger(oldestUnsentAgeMs) || oldestUnsentAgeMs < 0) {
    throw new Error("Outbox smoke query returned an invalid oldest pending age");
  }

  const failures: string[] = [];
  if (
    activeRelease === null ||
    activeRelease.release_status !== "PUBLISHED" ||
    activeRelease.ruleset_status !== "PUBLISHED"
  ) {
    failures.push("ACTIVE_CONTENT_RELEASE_INVALID");
  }
  if (
    initialAdmin === null ||
    initialAdmin.environment !== input.environment ||
    initialAdmin.principal_status !== "ACTIVE" ||
    initialAdmin.role_slug !== OWNER_SECURITY_ADMIN_ROLE ||
    !initialAdmin.global_scope_active
  ) {
    failures.push("INITIAL_ADMIN_BOOTSTRAP_INVALID");
  }
  if (session === null) failures.push("WHATSAPP_SESSION_MISSING");
  if (outbox.dead_count > 0) failures.push("OUTBOX_DEAD_MESSAGES_PRESENT");
  if (outbox.unsent_count >= criticalQueueDepth) failures.push("OUTBOX_CRITICAL_DEPTH");
  if (oldestUnsentAgeMs >= criticalQueueAgeMs) failures.push("OUTBOX_CRITICAL_AGE");

  return {
    passed: failures.length === 0,
    environment: input.environment,
    deploymentRevision: input.deploymentRevision,
    schemaCurrent: true,
    activeRelease:
      activeRelease === null
        ? null
        : {
            releaseNo: activeRelease.release_no,
            releaseStatus: activeRelease.release_status,
            rulesetStatus: activeRelease.ruleset_status,
          },
    initialAdmin:
      initialAdmin === null
        ? null
        : {
            environment: initialAdmin.environment,
            principalStatus: initialAdmin.principal_status,
            roleSlug: initialAdmin.role_slug,
            globalScopeActive: initialAdmin.global_scope_active,
          },
    whatsappSession: { present: session !== null, revision: session?.revision ?? null },
    outbox: {
      deadCount: outbox.dead_count,
      unsentCount: outbox.unsent_count,
      oldestUnsentAgeMs,
      criticalQueueAgeMs,
      criticalQueueDepth,
    },
    providerLiveHealth: "NOT_PROBED",
    finalPostDeploySmokeComplete: false,
    failures,
  };
}
