import { z } from "zod";
import type { ReleaseDiff } from "../catalog/diff.js";
import type { CatalogReleaseAdminService } from "../catalog/release-admin-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminService } from "./service.js";

const ContentReleaseDiffReadInputSchema = z
  .object({
    principalId: z.string().uuid(),
    correlationId: z.string().uuid(),
    fromReleaseId: z.string().uuid(),
    toReleaseId: z.string().uuid(),
  })
  .strict()
  .refine((value) => value.fromReleaseId !== value.toReleaseId, {
    message: "Release diff requires two distinct releases",
    path: ["toReleaseId"],
  });

export class ContentReleaseReadService {
  public constructor(
    private readonly authorizer: Pick<AdminService, "authorizeRead">,
    private readonly owner: Pick<CatalogReleaseAdminService, "diffReleases">,
  ) {}

  public async diff(rawInput: unknown): Promise<ReleaseDiff> {
    const parsed = ContentReleaseDiffReadInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid content release diff request");
    }

    const input = parsed.data;
    await this.authorizer.authorizeRead({
      principalId: input.principalId,
      operationType: "content.release.diff",
      input: {
        fromReleaseId: input.fromReleaseId,
        toReleaseId: input.toReleaseId,
      },
    });

    const result = await this.owner.diffReleases(input.fromReleaseId, input.toReleaseId);
    if (result.ok) return result.value;
    if (result.error.code === "NOT_FOUND") {
      throw new AdminError(
        ADMIN_ERROR_CODES.TARGET_NOT_FOUND,
        result.error.message,
        result.error.details,
      );
    }
    throw new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, result.error.message, {
      ownerCode: result.error.code,
      ...(result.error.details ?? {}),
    });
  }
}
