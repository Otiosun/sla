import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import { CompetitiveSpawnImagePreparation } from "../../src/platform/competitive-spawn/competitive-spawn-image-preparation.js";

function message(centerX = 500): PendingOutboxMessage {
  return {
    id: "outbox-render-test",
    channel: "whatsapp",
    destinationRef: "120363000000000000@g.us",
    messageType: "IMAGE",
    payload: {
      caption: "\u2728 Um Pokemon selvagem apareceu!",
      competitiveSpawnRender: {
        schemaVersion: 1,
        backgroundUrl: "https://assets.test/background.png",
        spriteUrl: "https://assets.test/sprite.png",
        fallbackSpriteUrl: "https://assets.test/fallback.png",
        centerX,
        groundY: 438,
        maxSize: 320,
        floatY: 0,
        shadowOpacity: 0.25,
        timeBucket: "DAY",
      },
    },
    idempotencyKey: "render:test",
    correlationId: "11111111-1111-4111-8111-111111111111",
    causationId: null,
    attempts: 0,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("competitive spawn renderer", () => {
  it("produces a cached 800x500 PNG and strips private render instructions from the outbound payload", async () => {
    const background = await sharp({
      create: {
        width: 800,
        height: 500,
        channels: 4,
        background: { r: 18, g: 40, b: 60, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const spriteSvg = Buffer.from(
      '<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">' +
        '<ellipse cx="150" cy="180" rx="90" ry="110" fill="#f5d742"/>' +
        '<circle cx="120" cy="150" r="12" fill="#111"/>' +
        '<circle cx="180" cy="150" r="12" fill="#111"/>' +
        "</svg>",
    );
    const sprite = await sharp(spriteSvg).png().toBuffer();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("background") ? background : sprite;
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const preparation = new CompetitiveSpawnImagePreparation();
    const first = await preparation.prepare(message());
    const second = await preparation.prepare(message(520));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstPayload = first?.payload ?? {};
    expect(firstPayload.competitiveSpawnRender).toBeUndefined();
    expect(typeof firstPayload.imageBase64).toBe("string");

    const png = Buffer.from(String(firstPayload.imageBase64), "base64");
    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(800);
    expect(metadata.height).toBe(500);
  });
});
