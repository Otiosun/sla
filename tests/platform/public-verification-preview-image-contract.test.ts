import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = new URL(
  "../../.github/workflows/publish-security-preview-image.yml",
  import.meta.url,
);
const DOCKERFILE_PATH = new URL("../../Dockerfile", import.meta.url);

describe("public verification security preview image publisher", () => {
  it("publishes only immutable SHA tags from the isolated Ed25519 W4 branch", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("security/w4-ed25519-signatures-v1");
    expect(workflow).toContain("ghcr.io/${GITHUB_REPOSITORY,,}:sha-${GITHUB_SHA}");
    expect(workflow).toContain("org.opencontainers.image.revision=${GITHUB_SHA}");
    expect(workflow).toContain("--provenance=mode=max");
    expect(workflow).toContain("--sbom=true");
    expect(workflow).not.toContain(":main");
    expect(workflow).not.toContain("RUNTIME_IMAGE_MAIN");
  });

  it("builds the dedicated public-verification runtime without changing the WhatsApp default", async () => {
    const [workflow, dockerfile] = await Promise.all([
      readFile(WORKFLOW_PATH, "utf8"),
      readFile(DOCKERFILE_PATH, "utf8"),
    ]);

    expect(workflow).toContain("--target public-verification-runtime");
    expect(dockerfile).toContain("AS public-verification-runtime");
    expect(dockerfile).toContain('CMD ["node", "dist/src/public-verification-main.js"]');
    expect(dockerfile).toContain("AS runtime");
    expect(dockerfile).toContain('CMD ["node", "dist/src/main.js"]');
    expect(dockerfile.lastIndexOf("AS runtime")).toBeGreaterThan(
      dockerfile.lastIndexOf("AS public-verification-runtime"),
    );
  });

  it("fails closed if the workflow is ever invoked from a different ref", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/security/w4-ed25519-signatures-v1" ]]',
    );
    expect(workflow).toContain("exit 64");
  });
});
