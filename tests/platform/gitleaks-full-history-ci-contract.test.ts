import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/secret-history-scan.yml",
] as const;

describe("gitleaks full-history CI contract", () => {
  for (const workflowPath of workflows) {
    it(`${workflowPath} fetches and explicitly scans all reachable history`, () => {
      const workflow = readFileSync(workflowPath, "utf8");

      expect(workflow).toMatch(/fetch-depth:\s*0/);
      expect(workflow).toContain("git rev-list --all --count");
      expect(workflow).toContain('gitleaks detect --redact --verbose --exit-code=2 --log-opts="--all"');
      expect(workflow).not.toContain('gitleaks detect --redact --verbose --exit-code=2 --log-opts="-1"');
    });
  }
});
