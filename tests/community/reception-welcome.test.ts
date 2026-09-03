import { describe, expect, it } from "vitest";
import { ReceptionService } from "../../src/modules/community/reception-service.js";
import type { PlayerAccessStatus } from "../../src/modules/registration/player-access-ports.js";
import type { RegistrationRevisionStatus } from "../../src/modules/registration/ports.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const GROUP_ID = "11111111-1111-4111-8111-111111111111";

interface HarnessOptions {
  readonly knownReception?: boolean;
  readonly playerKnown?: boolean;
  readonly needsFirstWelcome?: boolean;
  readonly draft?: boolean;
  readonly reviewStatus?: RegistrationRevisionStatus | null;
  readonly accessStatus?: PlayerAccessStatus;
  readonly firstInteraction?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let registrationReads = 0;
  let welcomeClaims = 0;
  let identityCreates = 0;
  let identityReads = 0;
  let welcomeAdmissionReads = 0;

  const players = {
    resolveOrCreatePlayer: async (_input: {
      readonly provider: string;
      readonly externalId: string;
    }) => {
      identityCreates += 1;
      return ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false });
    },
    resolvePlayer: async (_input: { readonly provider: string; readonly externalId: string }) => {
      identityReads += 1;
      return options.playerKnown === false
        ? err(appError("NOT_FOUND", "unknown player"))
        : ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false });
    },
  };
  const presence = {
    claimFirstWelcome: async (_input: { readonly groupId: string; readonly playerId: string }) => {
      welcomeClaims += 1;
      return options.firstInteraction ?? true;
    },
    needsFirstWelcome: async (_input: { readonly groupId: string; readonly playerId: string }) => {
      welcomeAdmissionReads += 1;
      return options.needsFirstWelcome ?? true;
    },
  };

  const service = new ReceptionService({
    community: {
      resolveChat: async (_input: { readonly provider: string; readonly chatRef: string }) =>
        options.knownReception === false
          ? { known: false, groupId: null, role: null, capabilities: [] as const }
          : {
              known: true,
              groupId: GROUP_ID,
              role: "RECEPTION" as const,
              capabilities: ["onboarding"] as const,
            },
    },
    players,
    registration: {
      getCurrentReview: async (_playerId: string) => {
        registrationReads += 1;
        return options.reviewStatus === undefined || options.reviewStatus === null
          ? err(appError("NOT_FOUND", "no review"))
          : ok({ status: options.reviewStatus });
      },
      getDraft: async (_playerId: string) => {
        registrationReads += 1;
        return options.draft === true
          ? ok({ revision: 2 })
          : err(appError("NOT_FOUND", "no draft"));
      },
    },
    access: {
      load: async (_playerId: string) => ({
        playerId: PLAYER_ID,
        status: options.accessStatus ?? "PENDING",
        approvedReviewId: options.accessStatus === "PROVISIONING" ? "review-approved" : null,
        revision: options.accessStatus === "PENDING" || options.accessStatus === undefined ? 0 : 1,
      }),
    },
    presence,
  });

  return {
    service,
    registrationReads: () => registrationReads,
    welcomeClaims: () => welcomeClaims,
    identityCreates: () => identityCreates,
    identityReads: () => identityReads,
    welcomeAdmissionReads: () => welcomeAdmissionReads,
  };
}

const INPUT = {
  provider: "baileys",
  chatRef: "120363000000000001@g.us",
  externalId: "5511999999999@s.whatsapp.net",
} as const;

async function textFor(options: HarnessOptions): Promise<string | null> {
  const result = await harness(options).service.firstInteraction(INPUT);
  if (!result.ok) throw result.error;
  return result.value?.text ?? null;
}

describe("ReceptionService state-aware first interaction", () => {
  it("guides a player with no registration to $registrar", async () => {
    expect(await textFor({})).toMatch(/\$registrar/i);
  });

  it("guides an existing draft to $continuar and $ficha", async () => {
    const text = await textFor({ draft: true });
    expect(text).toMatch(/\$continuar/i);
    expect(text).toMatch(/\$ficha/i);
    expect(text).not.toMatch(/começar.*do zero/i);
  });

  it("reports SUBMITTED as in analysis without reopening onboarding", async () => {
    const text = await textFor({ draft: true, reviewStatus: "SUBMITTED" });
    expect(text).toMatch(/an[aá]lise/i);
    expect(text).not.toMatch(/\$registrar/i);
  });

  it("guides CHANGES_REQUESTED to $editar while preserving the existing ficha", async () => {
    const text = await textFor({ draft: true, reviewStatus: "CHANGES_REQUESTED" });
    expect(text).toMatch(/\$editar/i);
    expect(text).toMatch(/ajuste|altera/i);
  });

  it("reports APPROVED + PROVISIONING as provisioning, not novice onboarding", async () => {
    const text = await textFor({ reviewStatus: "APPROVED", accessStatus: "PROVISIONING" });
    expect(text).toMatch(/aprovad/i);
    expect(text).toMatch(/libera|provision/i);
    expect(text).not.toMatch(/\$registrar|passo a passo/i);
  });

  it("treats ACTIVE as a returning player and does not read novice registration state", async () => {
    const active = harness({ accessStatus: "ACTIVE" });
    const result = await active.service.firstInteraction(INPUT);
    if (!result.ok) throw result.error;

    expect(result.value?.text).toMatch(/volta|retorno|bem-vind/i);
    expect(result.value?.text).not.toMatch(/\$registrar|\$continuar|\$editar|passo a passo/i);
    expect(active.registrationReads()).toBe(0);
  });

  it("keeps REJECTED explicit instead of silently creating another registration", async () => {
    const text = await textFor({ reviewStatus: "REJECTED" });
    expect(text).toMatch(/rejeitad/i);
    expect(text).not.toMatch(/nova ficha|\$registrar/i);
  });

  it("fails closed outside an active Reception", async () => {
    const unknown = harness({ knownReception: false });
    const result = await unknown.service.firstInteraction(INPUT);
    if (!result.ok) throw result.error;

    expect(result.value).toBeNull();
    expect(unknown.welcomeClaims()).toBe(0);
    expect(unknown.registrationReads()).toBe(0);
  });

  it("emits at most one first-interaction welcome for an already known presence generation", async () => {
    const repeated = harness({ accessStatus: "ACTIVE", firstInteraction: false });
    const result = await repeated.service.firstInteraction(INPUT);
    if (!result.ok) throw result.error;

    expect(result.value).toBeNull();
    expect(repeated.welcomeClaims()).toBe(1);
    expect(repeated.registrationReads()).toBe(0);
  });

  it("admits an unknown identity in Reception without creating persistent identity during admission", async () => {
    const unknown = harness({ playerKnown: false });

    expect(await unknown.service.admitsFirstInteraction(INPUT)).toBe(true);
    expect(unknown.identityReads()).toBe(1);
    expect(unknown.identityCreates()).toBe(0);
    expect(unknown.welcomeAdmissionReads()).toBe(0);
  });

  it("admits a known player only while the current Reception presence still needs a welcome", async () => {
    const first = harness({ needsFirstWelcome: true });
    expect(await first.service.admitsFirstInteraction(INPUT)).toBe(true);
    expect(first.welcomeAdmissionReads()).toBe(1);

    const repeated = harness({ needsFirstWelcome: false });
    expect(await repeated.service.admitsFirstInteraction(INPUT)).toBe(false);
    expect(repeated.welcomeAdmissionReads()).toBe(1);
  });

  it("does not perform identity or presence admission reads outside Reception", async () => {
    const outside = harness({ knownReception: false });

    expect(await outside.service.admitsFirstInteraction(INPUT)).toBe(false);
    expect(outside.identityReads()).toBe(0);
    expect(outside.identityCreates()).toBe(0);
    expect(outside.welcomeAdmissionReads()).toBe(0);
  });
});
