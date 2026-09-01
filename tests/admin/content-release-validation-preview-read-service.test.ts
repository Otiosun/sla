import { describe, expect, it, vi } from "vitest";
import { ContentReleaseReadService } from "../../src/modules/admin/content-release-read-service.js";
import type { AdminService } from "../../src/modules/admin/service.js";
import type { CatalogReleaseAdminService } from "../../src/modules/catalog/release-admin-service.js";
import { ok } from "../../src/shared-kernel/result.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const RELEASE_ID = "33333333-3333-4333-8333-333333333333";

describe("content release validation preview read service", () => {
  it("authorizes the read operation before returning authoritative blockers", async () => {
    const authorizeRead = vi.fn().mockResolvedValue(undefined);
    const previewValidation = vi.fn().mockResolvedValue(
      ok({
        valid: false,
        issues: [
          {
            code: "FORM_SPECIES_MISSING",
            path: "forms.0.speciesId",
            message: "Form references a species absent from this release",
          },
        ],
      }),
    );
    const service = new ContentReleaseReadService(
      { authorizeRead } as unknown as Pick<AdminService, "authorizeRead">,
      { previewValidation } as unknown as CatalogReleaseAdminService,
    );

    const result = await service.validationPreview({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
      releaseId: RELEASE_ID,
    });

    expect(authorizeRead).toHaveBeenCalledTimes(1);
    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "content.release.validation_preview",
      input: { releaseId: RELEASE_ID },
    });
    expect(previewValidation).toHaveBeenCalledTimes(1);
    expect(previewValidation).toHaveBeenCalledWith(RELEASE_ID);
    expect(result).toEqual({
      valid: false,
      issues: [
        {
          code: "FORM_SPECIES_MISSING",
          path: "forms.0.speciesId",
          message: "Form references a species absent from this release",
        },
      ],
    });
  });
});
