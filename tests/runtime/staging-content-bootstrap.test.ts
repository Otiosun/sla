import { describe, expect, test } from "vitest";
import {
  planStagingContentBootstrap,
  STAGING_GEN123_RELEASE_ID,
  type StagingContentBootstrapState,
} from "../../scripts/operations/staging-content-bootstrap.js";

const phase4 = {
  id: "00000000-0000-4000-8000-000000000001",
  releaseNo: 1,
  status: "PUBLISHED" as const,
};

const candidate = {
  id: STAGING_GEN123_RELEASE_ID,
  releaseNo: 15001,
  status: "PUBLISHED" as const,
};

function state(
  overrides: Partial<StagingContentBootstrapState> = {},
): StagingContentBootstrapState {
  return {
    activeRelease: null,
    phase4Release: null,
    candidateRelease: null,
    unexpectedReleaseCount: 0,
    unexpectedRulesetCount: 0,
    ...overrides,
  };
}

describe("planStagingContentBootstrap", () => {
  test("seeds the Phase 4 baseline only for a truly empty catalog", () => {
    expect(planStagingContentBootstrap(state())).toBe("SEED_BASELINE_AND_PROMOTE");
  });

  test("promotes Gen I-III when the canonical Phase 4 release is ACTIVE", () => {
    expect(
      planStagingContentBootstrap(
        state({
          activeRelease: phase4,
          phase4Release: phase4,
        }),
      ),
    ).toBe("PROMOTE_CANDIDATE");
  });

  test("treats the canonical ACTIVE Gen I-III release as an idempotent replay", () => {
    expect(
      planStagingContentBootstrap(
        state({
          activeRelease: candidate,
          phase4Release: phase4,
          candidateRelease: candidate,
        }),
      ),
    ).toBe("VERIFY_ACTIVE_CANDIDATE");
  });

  test("fails closed when any unexpected release or ruleset exists", () => {
    expect(() =>
      planStagingContentBootstrap(
        state({
          unexpectedReleaseCount: 1,
        }),
      ),
    ).toThrow(/unexpected staging catalog state/i);

    expect(() =>
      planStagingContentBootstrap(
        state({
          unexpectedRulesetCount: 1,
        }),
      ),
    ).toThrow(/unexpected staging catalog state/i);
  });

  test(
    "fails closed when the ACTIVE pointer is neither canonical Phase 4 nor published Gen I-III",
    () => {
      expect(() =>
        planStagingContentBootstrap(
          state({
            activeRelease: {
              id: "00000000-0000-4000-8000-000000000099",
              releaseNo: 99,
              status: "PUBLISHED",
            },
          }),
        ),
      ).toThrow(/unexpected staging catalog state/i);

      expect(() =>
        planStagingContentBootstrap(
          state({
            activeRelease: {
              ...candidate,
              status: "VALIDATED",
            },
            phase4Release: phase4,
            candidateRelease: {
              ...candidate,
              status: "VALIDATED",
            },
          }),
        ),
      ).toThrow(/unexpected staging catalog state/i);
    },
  );
});
