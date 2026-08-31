import { describe, expect, it, vi } from "vitest";
import { ContentLibraryService } from "../../src/modules/admin/content-library-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

describe("ContentLibraryService", () => {
  it("authorizes through the existing content capability family and forwards only parsed filters", async () => {
    const authorizeRead = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "ADMIN_AUTHORIZATION_DENIED" }),
      )
      .mockResolvedValue({ type: "CONTENT_COLLECTION", id: null });
    const searchContent = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const service = new ContentLibraryService({ authorizeRead }, { searchContent });

    await service.search({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
      query: "  pikachu  ",
      resourceKind: "SPECIES",
      releaseStatus: "DRAFT",
      active: true,
      limit: 25,
    });

    expect(authorizeRead).toHaveBeenNthCalledWith(1, {
      principalId: PRINCIPAL_ID,
      operationType: "content.library.search.create",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(authorizeRead).toHaveBeenNthCalledWith(2, {
      principalId: PRINCIPAL_ID,
      operationType: "content.library.search.edit",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(searchContent).toHaveBeenCalledWith({
      query: "pikachu",
      resourceKind: "SPECIES",
      releaseStatus: "DRAFT",
      active: true,
      limit: 25,
      cursor: null,
    });
  });

  it("fails closed on malformed filters before touching authorization or persistence", async () => {
    const authorizeRead = vi.fn();
    const searchContent = vi.fn();
    const service = new ContentLibraryService({ authorizeRead }, { searchContent });

    await expect(
      service.search({
        principalId: PRINCIPAL_ID,
        correlationId: CORRELATION_ID,
        resourceKind: "RAW_SQL",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_INPUT" });
    expect(authorizeRead).not.toHaveBeenCalled();
    expect(searchContent).not.toHaveBeenCalled();
  });
});
