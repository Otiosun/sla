import { promises as fs } from "node:fs";
import sharp from "sharp";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import { CompetitiveSpawnImagePreparation } from "../../src/platform/competitive-spawn/competitive-spawn-image-preparation.js";

const output = process.argv[2];
if (output === undefined || output.trim().length === 0) {
  throw new Error("Output PNG path is required");
}

const message: PendingOutboxMessage = {
  id: "v65-render-smoke",
  channel: "whatsapp",
  destinationRef: "120363000000000000@g.us",
  messageType: "IMAGE",
  payload: {
    caption: "\u2728 Um Pokemon selvagem apareceu!",
    competitiveSpawnRender: {
      schemaVersion: 1,
      backgroundUrl:
        "https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/main/backgrounds/1.png",
      spriteUrl:
        "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/25.png",
      fallbackSpriteUrl:
        "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png",
      centerX: 500,
      groundY: 438,
      maxSize: 320,
      floatY: 0,
      shadowOpacity: 0.27,
      timeBucket: "DAY",
    },
  },
  idempotencyKey: "v65:render:smoke",
  correlationId: "11111111-1111-4111-8111-111111111111",
  causationId: null,
  attempts: 0,
};

const preparation = new CompetitiveSpawnImagePreparation();
const prepared = await preparation.prepare(message);
if (prepared === undefined) throw new Error("Renderer did not prepare the spawn image");

const imageBase64 = prepared.payload.imageBase64;
if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
  throw new Error("Renderer did not produce imageBase64");
}
if ("competitiveSpawnRender" in prepared.payload) {
  throw new Error("Private render spec leaked into the prepared provider payload");
}

const png = Buffer.from(imageBase64, "base64");
const metadata = await sharp(png).metadata();
if (metadata.format !== "png" || metadata.width !== 800 || metadata.height !== 500) {
  throw new Error(
    `Unexpected render metadata: ${metadata.format} ${metadata.width}x${metadata.height}`,
  );
}

await fs.writeFile(output, png);
console.log(
  JSON.stringify({
    ok: true,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    bytes: png.length,
    output,
  }),
);
