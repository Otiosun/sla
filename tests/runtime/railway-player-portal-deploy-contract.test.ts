import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowUrl = new URL(
  "../../.github/workflows/railway-staging-player-portal-deploy.yml",
  import.meta.url,
);

describe("Railway staging Player Portal deploy contract", () => {
  it("deploys the immutable runtime as the dedicated Player Portal process", async () => {
    const workflow = await readFile(workflowUrl, "utf8");

    expect(workflow).toContain("pokemon-rpg-player-portal-staging");
    expect(workflow).toContain("STAGING_RAILWAY_PLAYER_PORTAL_SERVICE");
    expect(workflow).toContain("STAGING_PLAYER_PORTAL_URL");
    expect(workflow).toContain('CMD ["node","dist/src/player-portal-main.js"]');
    expect(workflow).toContain("RUNTIME_IMAGE_PINNED");
    expect(workflow).toContain("DEPLOY_REVISION=");
  });

  it("proves the public boundary without requiring a player session or WhatsApp", async () => {
    const workflow = await readFile(workflowUrl, "utf8");

    expect(workflow).toContain("/v1/hub/player/self");
    expect(workflow).toContain('status" == "401"');
    expect(workflow).toContain("UNAUTHENTICATED");
    expect(workflow).not.toContain("WHATSAPP_SESSION_KEY");
    expect(workflow).not.toContain("WHATSAPP_AUTH_KEY");
    expect(workflow).not.toContain("PAIRING_QR");
  });
});
