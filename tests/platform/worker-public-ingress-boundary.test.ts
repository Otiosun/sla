import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const railwayWorkflowPath = ".github/workflows/railway-staging-runtime-deploy.yml";
const flyConfigPath = "fly.staging.toml";

describe("staging worker public-ingress boundary", () => {
  it("fails closed on Railway HTTP domains and TCP proxies before and after deploy", () => {
    const workflow = readFileSync(railwayWorkflowPath, "utf8");

    expect(workflow).toContain("Assert Railway worker has no public ingress");
    expect(workflow).toContain(
      'railway domain list --service "$RAILWAY_SERVICE" --environment staging --json',
    );
    expect(workflow).toContain("tcpProxies(environmentId:$environmentId,serviceId:$serviceId)");
    expect(workflow).toContain(".data.tcpProxies");
    expect(workflow).toContain("Railway staging worker must not expose public HTTP domains");
    expect(workflow).toContain("Railway staging worker must not expose a public TCP proxy");

    const ingressAssertions = workflow.match(/Assert Railway worker has no public ingress/g) ?? [];
    expect(ingressAssertions).toHaveLength(2);
  });

  it("keeps Fly staging structurally worker-only", () => {
    const flyConfig = readFileSync(flyConfigPath, "utf8");

    expect(flyConfig).not.toMatch(/^\s*\[http_service\]\s*$/m);
    expect(flyConfig).not.toMatch(/^\s*\[\[services\]\]\s*$/m);
  });
});
