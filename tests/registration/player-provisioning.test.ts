import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  RegistrationRepository,
  RegistrationRevisionRecord,
  RegistrationTransaction,
} from "../../src/modules/registration/ports.js";
import type {
  PlayerAccessRecord,
  PlayerAccessRepository,
  PlayerAccessTransaction,
} from "../../src/modules/registration/player-access-ports.js";
import { PlayerProvisioningService } from "../../src/modules/registration/provisioning-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_FORM_ID = "22222222-2222-4222-8222-222222222222";

function approvedReview(playerId = createPlayerId()): RegistrationRevisionRecord {
  return {
    id: randomUUID(),
    playerId,
    sequenceNo: 1,
    status: "APPROVED",
    snapshot: {
      trainerName: "Liora Vale",
      age: 17,
      genderPronouns: "ela/dela",
      appearance: "Cabelos negros e casaco de viagem.",
      personality: "Curiosa, cautelosa e competitiva.",
      backstory: "Saiu de casa para pesquisar Pokémon raros.",
      starterFormId: STARTER_FORM_ID,
      regionId: REGION_ID,
      schemaVersion: 1,
    },
    revision: 1,
    decidedByAdminPrincipalId: "00000000-0000-4000-8000-000000000777",
  };
}

class ReviewRepository implements RegistrationRepository {
  public constructor(private readonly review: RegistrationRevisionRecord) {}

  private tx(): RegistrationTransaction {
    return {
      loadDraft: async () => null,
      saveDraft: async () => null,
      loadCurrentRevision: async () => this.review,
      loadRevisionById: async (id) => (id === this.review.id ? this.review : null),
      loadIdempotencyReceipt: async () => null,
      insertRevision: async () => {
        throw new Error("unused");
      },
      saveIdempotencyReceipt: async () => undefined,
      updateRevisionStatus: async () => null,
    };
  }

  public async transaction<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx());
  }

  public async read<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx());
  }
}

class AccessRepository implements PlayerAccessRepository {
  public record: PlayerAccessRecord | null = null;

  private tx: PlayerAccessTransaction = {
    load: async (playerId) =>
      this.record ?? { playerId, status: "PENDING", approvedReviewId: null, revision: 0 },
    beginProvisioning: async (input) => {
      const current = this.record ?? {
        playerId: input.playerId,
        status: "PENDING" as const,
        approvedReviewId: null,
        revision: 0,
      };
      if (current.revision !== input.expectedRevision) return null;
      if (current.status === "PROVISIONING" && current.approvedReviewId === input.reviewId) {
        return current;
      }
      if (current.status !== "PENDING") return null;
      this.record = {
        playerId: input.playerId,
        status: "PROVISIONING",
        approvedReviewId: input.reviewId,
        revision: current.revision + 1,
      };
      return this.record;
    },
    activate: async (input) => {
      const current = this.record;
      if (
        current === null ||
        current.status !== "PROVISIONING" ||
        current.approvedReviewId !== input.reviewId ||
        current.revision !== input.expectedRevision
      ) {
        return null;
      }
      this.record = { ...current, status: "ACTIVE", revision: current.revision + 1 };
      return this.record;
    },
    suspend: async (input) => {
      const current = this.record;
      if (
        current === null ||
        current.status !== "ACTIVE" ||
        current.revision !== input.expectedRevision
      ) {
        return null;
      }
      this.record = { ...current, status: "SUSPENDED", revision: current.revision + 1 };
      return this.record;
    },
    restore: async (input) => {
      const current = this.record;
      if (
        current === null ||
        current.status !== "SUSPENDED" ||
        current.revision !== input.expectedRevision
      ) {
        return null;
      }
      this.record = { ...current, status: "ACTIVE", revision: current.revision + 1 };
      return this.record;
    },
  };

  public async transaction<T>(fn: (tx: PlayerAccessTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx);
  }

  public async read<T>(fn: (tx: PlayerAccessTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx);
  }
}

function createMechanicalHarness() {
  const state = {
    profileCreated: false,
    regionSelected: false,
    starterPrepared: false,
    starterGranted: false,
    onboardingComplete: false,
    locationInitialized: false,
    starterCreates: 0,
    failAt: null as "PROFILE" | "STARTER" | "LOCATION" | null,
  };

  return {
    state,
    registration: {
      createProfile: async () => {
        if (state.failAt === "PROFILE") {
          return err(appError("FEATURE_UNAVAILABLE", "profile failed"));
        }
        state.profileCreated = true;
        return ok({ playerId: createPlayerId(), state: "PROFILE_CREATED" as const });
      },
      selectRegion: async () => {
        state.regionSelected = true;
        return ok({ playerId: createPlayerId(), state: "REGION_SELECTED" as const });
      },
    },
    starter: {
      prepareStarterSelection: async () => {
        state.starterPrepared = true;
        return ok({ playerId: createPlayerId(), starterClaimKey: "claim", options: [] });
      },
      grantStarter: async () => {
        if (!state.starterGranted) state.starterCreates += 1;
        state.starterGranted = true;
        if (state.failAt === "STARTER") {
          return err(appError("FEATURE_UNAVAILABLE", "starter failed"));
        }
        return ok({
          playerId: createPlayerId(),
          pokemonInstanceId: "00000000-0000-4000-8000-000000000888" as never,
          state: "STARTER_GRANTED" as const,
          replayed: false,
        });
      },
      completeOnboarding: async () => {
        state.onboardingComplete = true;
        return ok({ playerId: createPlayerId(), state: "COMPLETE" as const });
      },
    },
    world: {
      ensureInitialLocation: async () => {
        if (state.failAt === "LOCATION") {
          return err(appError("FEATURE_UNAVAILABLE", "location failed"));
        }
        state.locationInitialized = true;
        return ok({} as never);
      },
    },
  };
}

describe("post-approval player provisioning", () => {
  it("moves approved registration through PROVISIONING and only then ACTIVE", async () => {
    const review = approvedReview();
    const access = new AccessRepository();
    const mechanical = createMechanicalHarness();
    const service = new PlayerProvisioningService(
      new ReviewRepository(review),
      access,
      mechanical.registration,
      mechanical.starter,
      mechanical.world,
    );

    const result = await service.provisionApprovedPlayer(review.id);

    expect(result).toMatchObject({
      ok: true,
      value: { status: "ACTIVE", approvedReviewId: review.id },
    });
    expect(access.record?.status).toBe("ACTIVE");
    expect(mechanical.state).toMatchObject({
      profileCreated: true,
      regionSelected: true,
      starterPrepared: true,
      starterGranted: true,
      onboardingComplete: true,
      locationInitialized: true,
      starterCreates: 1,
    });
  });

  it("refuses provisioning when the registration revision is not approved", async () => {
    const review = {
      ...approvedReview(),
      status: "SUBMITTED" as const,
      decidedByAdminPrincipalId: null,
    };
    const access = new AccessRepository();
    const mechanical = createMechanicalHarness();
    const service = new PlayerProvisioningService(
      new ReviewRepository(review),
      access,
      mechanical.registration,
      mechanical.starter,
      mechanical.world,
    );

    expect(await service.provisionApprovedPlayer(review.id)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(access.record).toBeNull();
  });

  it("keeps PROVISIONING after failure and resumes without duplicating the starter", async () => {
    const review = approvedReview();
    const access = new AccessRepository();
    const mechanical = createMechanicalHarness();
    mechanical.state.failAt = "LOCATION";
    const service = new PlayerProvisioningService(
      new ReviewRepository(review),
      access,
      mechanical.registration,
      mechanical.starter,
      mechanical.world,
    );

    const failed = await service.provisionApprovedPlayer(review.id);
    expect(failed).toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    expect(access.record?.status).toBe("PROVISIONING");
    expect(mechanical.state.starterCreates).toBe(1);
    expect(mechanical.state.onboardingComplete).toBe(true);

    mechanical.state.failAt = null;
    const resumed = await service.provisionApprovedPlayer(review.id);
    expect(resumed).toMatchObject({ ok: true, value: { status: "ACTIVE" } });
    expect(mechanical.state.starterCreates).toBe(1);
    expect(mechanical.state.locationInitialized).toBe(true);
  });

  it("suspends and restores ACTIVE access without running provisioning again", async () => {
    const review = approvedReview();
    const access = new AccessRepository();
    const mechanical = createMechanicalHarness();
    const service = new PlayerProvisioningService(
      new ReviewRepository(review),
      access,
      mechanical.registration,
      mechanical.starter,
      mechanical.world,
    );
    const active = await service.provisionApprovedPlayer(review.id);
    if (!active.ok) throw active.error;
    const starterCreates = mechanical.state.starterCreates;

    const suspended = await service.suspend(review.playerId, active.value.revision);
    expect(suspended).toMatchObject({ ok: true, value: { status: "SUSPENDED" } });
    if (!suspended.ok) throw suspended.error;

    const restored = await service.restore(review.playerId, suspended.value.revision);
    expect(restored).toMatchObject({ ok: true, value: { status: "ACTIVE" } });
    expect(mechanical.state.starterCreates).toBe(starterCreates);
  });
});
