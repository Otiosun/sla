import { describe, expect, it } from "vitest";
import {
  WorldServiceMediaRuntimeConfigError,
  loadWorldServiceMediaRuntimeConfig,
} from "../../src/runtime/world-service-media-runtime-config.js";

const AREA_ID = "00000000-0000-4000-8000-000000002701";
const FACADE_URL = "https://assets.example.test/pokemart-arrozais.png";
const MERCHANT_URL = "https://assets.example.test/pokemart-merchant.png";

describe("World Service media runtime config", () => {
  it("keeps media disabled when the Poké Mart media block is absent", () => {
    expect(loadWorldServiceMediaRuntimeConfig({})).toBeNull();
  });

  it("loads one area-scoped Poké Mart media catalog from validated HTTPS URLs", () => {
    const media = loadWorldServiceMediaRuntimeConfig({
      POKEMART_ENTRY_AREA_ID: AREA_ID,
      POKEMART_ENTRY_FACADE_IMAGE_URL: FACADE_URL,
      POKEMART_ENTRY_MERCHANT_IMAGE_URL: MERCHANT_URL,
    });

    expect(media).not.toBeNull();
    expect(media?.pokemartEntry(AREA_ID)).toEqual({
      facadeImageUrl: FACADE_URL,
      merchantImageUrl: MERCHANT_URL,
    });
    expect(media?.pokemartEntry("00000000-0000-4000-8000-000000002702")).toBeNull();
  });

  it("rejects a partial Poké Mart media block", () => {
    expect(() =>
      loadWorldServiceMediaRuntimeConfig({
        POKEMART_ENTRY_AREA_ID: AREA_ID,
        POKEMART_ENTRY_FACADE_IMAGE_URL: FACADE_URL,
      }),
    ).toThrow(WorldServiceMediaRuntimeConfigError);
  });

  it("rejects non-HTTPS media URLs before the runtime starts", () => {
    expect(() =>
      loadWorldServiceMediaRuntimeConfig({
        POKEMART_ENTRY_AREA_ID: AREA_ID,
        POKEMART_ENTRY_FACADE_IMAGE_URL: "http://assets.example.test/pokemart.png",
        POKEMART_ENTRY_MERCHANT_IMAGE_URL: MERCHANT_URL,
      }),
    ).toThrow(/HTTPS/);
  });
});
