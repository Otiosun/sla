import type { Pool } from "pg";
import type { RegistrationSetup } from "../../modules/registration/whatsapp-handlers.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

interface RegionSetupRow {
  readonly content_release_id: string;
  readonly region_id: string;
  readonly region_display_name: string;
}

interface StarterSetupRow {
  readonly form_id: string;
  readonly display_name: string;
}

export class PostgresRegistrationSetupLoader {
  public constructor(private readonly pool: Pool) {}

  public async load(): Promise<Result<RegistrationSetup>> {
    const regionResult = await this.pool.query<RegionSetupRow>(
      `SELECT cr.id AS content_release_id,
              r.id AS region_id,
              rr.display_name AS region_display_name
       FROM content_release_pointers pointer
       JOIN content_releases cr
         ON cr.id = pointer.content_release_id
        AND cr.status = 'PUBLISHED'
       JOIN regions r
         ON r.slug = 'zhoulia'
       JOIN region_revisions rr
         ON rr.content_release_id = cr.id
        AND rr.region_id = r.id
        AND rr.active = TRUE
       WHERE pointer.pointer_key = 'ACTIVE'`,
    );
    const region = regionResult.rows[0];
    if (region === undefined) {
      return err(
        appError(
          "FEATURE_UNAVAILABLE",
          "Canonical registration region is unavailable in the active content release",
        ),
      );
    }

    const starterResult = await this.pool.query<StarterSetupRow>(
      `SELECT starter.form_id,
              form_revision.display_name
       FROM starter_options starter
       JOIN pokemon_form_revisions form_revision
         ON form_revision.content_release_id = starter.content_release_id
        AND form_revision.form_id = starter.form_id
        AND form_revision.active = TRUE
       WHERE starter.content_release_id = $1
         AND starter.region_id = $2
         AND starter.active = TRUE
       ORDER BY starter.sort_order, starter.form_id`,
      [region.content_release_id, region.region_id],
    );
    if (starterResult.rows.length === 0) {
      return err(
        appError(
          "FEATURE_UNAVAILABLE",
          "Canonical registration starters are unavailable for Zhoulia",
        ),
      );
    }

    return ok({
      regionId: region.region_id,
      regionDisplayName: region.region_display_name,
      starterOptions: starterResult.rows.map((starter) => ({
        formId: starter.form_id,
        displayName: starter.display_name,
      })),
    });
  }
}
