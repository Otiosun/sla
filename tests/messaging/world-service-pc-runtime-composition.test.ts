import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const pcComposition = vi.hoisted(() => ({
  repositoryConstructor: vi.fn(),
  serviceConstructor: vi.fn(),
}));

vi.mock("../../src/platform/world-services/postgres-pokemon-pc-storage-repository.js", () => ({
  PostgresPokemonPcStorageRepository: class {
    public constructor(pool: Pool) {
      pcComposition.repositoryConstructor(pool, this);
    }
  },
}));

vi.mock("../../src/modules/world-services/pc-storage-service.js", () => ({
  PokemonPcStorageService: class {
    public constructor(repository: unknown) {
      pcComposition.serviceConstructor(repository);
    }
  },
}));

import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

describe("Pokemon PC runtime composition", () => {
  it("composes the canonical PostgreSQL PC repository into the PC storage service", () => {
    const pool = {} as Pool;

    const composition = createOperationalMessagingComposition(pool);

    expect(
      composition.admitCommand({
        provider: "baileys",
        externalMessageId: "pc-runtime-composition",
        senderRef: "5511999999999@s.whatsapp.net",
        chatRef: "120363000000000901@g.us",
        occurredAt: "2026-09-07T12:00:00.000Z",
        text: "/pc",
        mediaRefs: [],
        replyToExternalMessageId: null,
      }),
    ).toBe(true);
    expect(pcComposition.repositoryConstructor).toHaveBeenCalledOnce();
    const repository = pcComposition.repositoryConstructor.mock.calls[0]?.[1];
    expect(pcComposition.repositoryConstructor).toHaveBeenCalledWith(pool, repository);
    expect(pcComposition.serviceConstructor).toHaveBeenCalledOnce();
    expect(pcComposition.serviceConstructor).toHaveBeenCalledWith(repository);
  });
});
