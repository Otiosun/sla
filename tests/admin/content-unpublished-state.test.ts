import { describe, expect, it, vi } from "vitest";
import { ContentLibraryService } from "../../src/modules/admin/content-library-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

describe("Content Studio unpublished state", () => {
  it("lists only backend-owned unpublished release state after content authorization", async () => {
    const authorizeRead = vi.fn().mockResolvedValue({});
    const listUnpublished = vi.fn().mockResolvedValue([
      {
        releaseId: "33333333-3333-4333-8333-333333333333",
        releaseNo: "92",
        releaseName: "Kanto balance pass",
        status: "DRAFT",
        workflowState: "EDITING",
        revision: "3",
        parentReleaseId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-08-31T22:00:00.000Z",
        validatedAt: null,
        recordedChangeCount: "3",
        lastChangedAt: "2026-08-31T22:15:00.000Z",
      },
      {
        releaseId: "55555555-5555-4555-8555-555555555555",
        releaseNo: "91",
        releaseName: "Kanto ready",
        status: "VALIDATED",
        workflowState: "READY_TO_PUBLISH",
        revision: "7",
        parentReleaseId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-08-31T20:00:00.000Z",
        validatedAt: "2026-08-31T21:00:00.000Z",
        recordedChangeCount: "7",
        lastChangedAt: "2026-08-31T20:50:00.000Z",
      },
    ]);
    const service = new ContentLibraryService(
      { authorizeRead },
      { searchContent: vi.fn(), listUnpublished },
    );

    const result = await service.listUnpublished({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual(await listUnpublished.mock.results[0]?.value);
    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "content.library.search.create",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(listUnpublished).toHaveBeenCalledTimes(1);
  });
});
