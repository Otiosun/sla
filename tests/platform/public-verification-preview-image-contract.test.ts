import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = new URL(
  "../../.github/workflows/publish-security-preview-image.yml",
  import.meta.url,
);

describe("public verification security preview image publisher", () => {
  it("publishes only immutable SHA tags from the isolated W4 branch", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("security/control-center-w4-antifraud-v1-clean");
    expect(workflow).toContain("ghcr.io/${GITHUB_REPOSITORY,,}:sha-${GITHUB_SHA}");
    expect(workflow).toContain("org.opencontainers.image.revision=${GITHUB_SHA}");
    expect(workflow).toContain("--provenance=mode=max");
    expect(workflow).toContain("--sbom=true");
    expect(workflow).not.toContain(":main");
    expect(workflow).not.toContain("RUNTIME_IMAGE_MAIN");
  });

  it("fails closed if the workflow is ever invoked from a different ref", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/security/control-center-w4-antifraud-v1-clean" ]]',
    );
    expect(workflow).toContain("exit 64");
  });
});
