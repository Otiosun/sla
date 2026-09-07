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
      expect(workflow).toContain(
        'gitleaks detect --redact --verbose --exit-code=2 --config=.gitleaks.toml --log-opts="--all"',
      );
      expect(workflow).not.toContain(
        'gitleaks detect --redact --verbose --exit-code=2 --log-opts="-1"',
      );
    });
  }

  it("keeps default detection and narrowly classifies known synthetic identifiers", () => {
    const config = readFileSync(".gitleaks.toml", "utf8");

    expect(config).toContain('minVersion = "8.30.1"');
    expect(config).toMatch(/\[extend\]\s+useDefault\s*=\s*true/);
    expect(config).toContain('regexTarget = "match"');
    expect(config).toContain("(?:idempotency|policy|offer)key");
    expect(config).toContain("cloudflare-access:example\\.cloudflareaccess\\.com");
    expect(config).not.toMatch(/^\s*paths\s*=/m);
    expect(config).not.toMatch(/^\s*commits\s*=/m);
  });
});
