import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const fishingComposition = vi.hoisted(() => ({
  attemptRepositoryConstructor: vi.fn(),
  seedProviderConstructor: vi.fn(),
  encounterServiceConstructor: vi.fn(),
  fishingServiceConstructor: vi.fn(),
}));

vi.mock("../../src/platform/world-services/postgres-fishing-attempt-repository.js", () => ({
  PostgresFishingAttemptRepository: class {
    public constructor(pool: Pool) {
      fishingComposition.attemptRepositoryConstructor(pool, this);
    }
  },
}));

vi.mock("../../src/platform/rng/encrypted-seed-provider.js", () => ({
  AesEncounterSeedProvider: class {
    public constructor(key: Uint8Array, keyVersion: number) {
      fishingComposition.seedProviderConstructor(key, keyVersion, this);
    }
  },
}));

vi.mock("../../src/modules/encounter/service.js", () => ({
  EncounterService: class {
    public constructor(
      repository: unknown,
      seedProvider: unknown,
      clock: unknown,
      feature: unknown,
    ) {
      fishingComposition.encounterServiceConstructor(
        repository,
        seedProvider,
        clock,
        feature,
        this,
      );
    }
  },
}));

vi.mock("../../src/modules/world-services/fishing-service.js", () => ({
  FishingService: class {
    public constructor(repository: unknown, encounters: unknown, random: unknown) {
      fishingComposition.fishingServiceConstructor(repository, encounters, random, this);
    }
  },
}));

import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

describe("Fishing runtime composition", () => {
  it("composes durable fishing and encounter owners when RNG configuration is supplied", () => {
    const pool = {} as Pool;
    const encryptionKey = Buffer.alloc(32, 0xa5);

    const composition = createOperationalMessagingComposition(pool, {
      encryptionKey,
      encryptionKeyVersion: 7,
    });

    expect(
      composition.admitCommand({
        provider: "baileys",
        externalMessageId: "fishing-runtime-composition",
        senderRef: "5511999999999@s.whatsapp.net",
        chatRef: "120363000000000901@g.us",
        occurredAt: "2026-09-08T03:00:00.000Z",
        text: "/pescar",
        mediaRefs: [],
        replyToExternalMessageId: null,
      }),
    ).toBe(true);

    expect(fishingComposition.attemptRepositoryConstructor).toHaveBeenCalledOnce();
    const attempts = fishingComposition.attemptRepositoryConstructor.mock.calls[0]?.[1];
    expect(fishingComposition.attemptRepositoryConstructor).toHaveBeenCalledWith(pool, attempts);

    expect(fishingComposition.seedProviderConstructor).toHaveBeenCalledOnce();
    const seedProvider = fishingComposition.seedProviderConstructor.mock.calls[0]?.[2];
    expect(fishingComposition.seedProviderConstructor).toHaveBeenCalledWith(
      encryptionKey,
      7,
      seedProvider,
    );

    expect(fishingComposition.encounterServiceConstructor).toHaveBeenCalledOnce();
    const encounters = fishingComposition.encounterServiceConstructor.mock.calls[0]?.[4];
    expect(fishingComposition.encounterServiceConstructor.mock.calls[0]?.[1]).toBe(seedProvider);
    expect(fishingComposition.encounterServiceConstructor.mock.calls[0]?.[3]).toEqual({
      enabled: true,
      reason: null,
    });

    expect(fishingComposition.fishingServiceConstructor).toHaveBeenCalledOnce();
    expect(fishingComposition.fishingServiceConstructor.mock.calls[0]?.[0]).toBe(attempts);
    expect(fishingComposition.fishingServiceConstructor.mock.calls[0]?.[1]).toBe(encounters);
  });
});
