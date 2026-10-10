import sharp from "sharp";
import type { CompetitiveSpawnRenderSpec } from "../../modules/competitive-spawn/contracts.js";
import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboxDeliveryPreparation } from "../../modules/messaging/ports.js";

const WIDTH = 800;
const HEIGHT = 500;
const MAX_REMOTE_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 96;
const MAX_REMOTE_ASSET_CACHE_ENTRIES = 192;
const remoteAssetCache = new Map<string, Promise<Buffer>>();

function renderSpec(value: unknown): CompetitiveSpawnRenderSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.backgroundUrl !== "string" ||
    typeof input.spriteUrl !== "string" ||
    typeof input.fallbackSpriteUrl !== "string" ||
    typeof input.centerX !== "number" ||
    typeof input.groundY !== "number" ||
    typeof input.maxSize !== "number" ||
    typeof input.floatY !== "number" ||
    typeof input.shadowOpacity !== "number"
  ) {
    return null;
  }
  return input as unknown as CompetitiveSpawnRenderSpec;
}

async function fetchRemoteBuffer(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Competitive spawn asset URL must be HTTPS");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) throw new Error(`Competitive spawn asset fetch failed: ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_REMOTE_BYTES) {
      throw new Error("Competitive spawn asset exceeds remote size limit");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_REMOTE_BYTES) {
      throw new Error("Competitive spawn asset has invalid size");
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const cached = remoteAssetCache.get(url);
  if (cached !== undefined) return cached;

  const pending = fetchRemoteBuffer(url).catch((error) => {
    remoteAssetCache.delete(url);
    throw error;
  });
  remoteAssetCache.set(url, pending);

  if (remoteAssetCache.size > MAX_REMOTE_ASSET_CACHE_ENTRIES) {
    const first = remoteAssetCache.keys().next().value as string | undefined;
    if (first !== undefined && first !== url) remoteAssetCache.delete(first);
  }

  return pending;
}
async function fetchSprite(spec: CompetitiveSpawnRenderSpec): Promise<Buffer> {
  try {
    return await fetchBuffer(spec.spriteUrl);
  } catch {
    return fetchBuffer(spec.fallbackSpriteUrl);
  }
}

function shadowSvg(centerX: number, groundY: number, width: number, opacity: number): Buffer {
  const rx = Math.max(36, Math.round(width * 0.28));
  const ry = Math.max(9, Math.round(rx * 0.18));
  const safeOpacity = Math.max(0.05, Math.min(0.38, opacity));
  return Buffer.from(
    `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><filter id="b"><feGaussianBlur stdDeviation="8"/></filter></defs>` +
      `<ellipse cx="${centerX}" cy="${groundY + 3}" rx="${rx}" ry="${ry}" ` +
      `fill="black" fill-opacity="${safeOpacity}" filter="url(#b)"/>` +
      `</svg>`,
  );
}

async function renderPng(spec: CompetitiveSpawnRenderSpec): Promise<Buffer> {
  const [background, spriteSource] = await Promise.all([
    fetchBuffer(spec.backgroundUrl),
    fetchSprite(spec),
  ]);

  const backgroundPng = await sharp(background)
    .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre", kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  const trimmed = await sharp(spriteSource).ensureAlpha().trim().png().toBuffer();
  const metadata = await sharp(trimmed).metadata();
  const sourceWidth = metadata.width ?? spec.maxSize;
  const sourceHeight = metadata.height ?? spec.maxSize;
  const scale = spec.maxSize / Math.max(sourceWidth, sourceHeight);
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const sprite = await sharp(trimmed)
    .resize(targetWidth, targetHeight, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  const left = Math.max(
    0,
    Math.min(WIDTH - targetWidth, Math.round(spec.centerX - targetWidth / 2)),
  );
  const top = Math.max(
    0,
    Math.min(HEIGHT - targetHeight, Math.round(spec.groundY - spec.floatY - targetHeight)),
  );

  return sharp(backgroundPng)
    .composite([
      {
        input: shadowSvg(
          Math.round(spec.centerX),
          Math.round(spec.groundY),
          targetWidth,
          spec.shadowOpacity,
        ),
        left: 0,
        top: 0,
      },
      { input: sprite, left, top },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

export class CompetitiveSpawnImagePreparation implements OutboxDeliveryPreparation {
  private readonly cache = new Map<string, Buffer>();

  public async prepare(message: PendingOutboxMessage): Promise<PendingOutboxMessage | undefined> {
    if (message.messageType !== "IMAGE") return undefined;
    const spec = renderSpec(message.payload.competitiveSpawnRender);
    if (spec === null) return undefined;

    const key = JSON.stringify(spec);
    let png = this.cache.get(key);
    if (png === undefined) {
      png = await renderPng(spec);
      this.cache.set(key, png);
      if (this.cache.size > MAX_CACHE_ENTRIES) {
        const first = this.cache.keys().next().value as string | undefined;
        if (first !== undefined) this.cache.delete(first);
      }
    }

    const payload = { ...message.payload };
    delete payload.competitiveSpawnRender;
    payload.imageBase64 = png.toString("base64");

    return { ...message, payload };
  }
}
