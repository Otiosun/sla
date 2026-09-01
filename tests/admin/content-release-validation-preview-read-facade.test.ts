import { describe, expect, it, vi } from "vitest";
import { AdminReadFacade } from "../../src/adapters/admin-api/read-facade.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const RELEASE_ID = "33333333-3333-4333-8333-333333333333";

const report = {
  valid: false,
  issues: [
    {
      code: "FORM_SPECIES_MISSING",
      path: "forms.0.speciesId",
      message: "Form references a species absent from this release",
    },
  ],
};

describe("AdminReadFacade content validation preview", () => {
  it("injects trusted authority and route release id", async () => {
    const validationPreview = vi.fn(async () => report);
    const facade = new AdminReadFacade({ search: vi.fn(), get: vi.fn() }, undefined, {
      diff: vi.fn(),
      validationPreview,
    });

    const result = await facade.previewContentReleaseValidation(
      {
        principalId: PRINCIPAL_ID,
        environment: "staging",
        correlationId: CORRELATION_ID,
      },
      RELEASE_ID,
    );

    expect(result).toEqual(report);
    expect(validationPreview).toHaveBeenCalledTimes(1);
    expect(validationPreview).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
      releaseId: RELEASE_ID,
    });
  });
});
