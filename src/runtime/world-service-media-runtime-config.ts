import { z } from "zod";
import type { WorldServiceMediaCatalog } from "../modules/world-services/whatsapp-handlers.js";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", "must use HTTPS");

const mediaSchema = z.object({
  POKEMART_ENTRY_AREA_ID: z.string().uuid().optional(),
  POKEMART_ENTRY_FACADE_IMAGE_URL: httpsUrl.optional(),
  POKEMART_ENTRY_MERCHANT_IMAGE_URL: httpsUrl.optional(),
});

export class WorldServiceMediaRuntimeConfigError extends Error {
  override readonly name = "WorldServiceMediaRuntimeConfigError";
}

export function loadWorldServiceMediaRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorldServiceMediaCatalog | null {
  const parsed = mediaSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new WorldServiceMediaRuntimeConfigError(
      `Invalid World Service media runtime configuration: ${issues}`,
    );
  }

  const areaId = parsed.data.POKEMART_ENTRY_AREA_ID;
  const facadeImageUrl = parsed.data.POKEMART_ENTRY_FACADE_IMAGE_URL;
  const merchantImageUrl = parsed.data.POKEMART_ENTRY_MERCHANT_IMAGE_URL;

  if (areaId === undefined && facadeImageUrl === undefined && merchantImageUrl === undefined) {
    return null;
  }
  if (areaId === undefined || facadeImageUrl === undefined || merchantImageUrl === undefined) {
    throw new WorldServiceMediaRuntimeConfigError(
      "Poké Mart entry media requires POKEMART_ENTRY_AREA_ID, POKEMART_ENTRY_FACADE_IMAGE_URL and POKEMART_ENTRY_MERCHANT_IMAGE_URL together",
    );
  }

  return {
    pokemartEntry: (requestedAreaId) =>
      requestedAreaId === areaId
        ? {
            facadeImageUrl,
            merchantImageUrl,
          }
        : null,
  };
}
