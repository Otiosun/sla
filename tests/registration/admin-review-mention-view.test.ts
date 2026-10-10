import { describe, expect, it, vi } from "vitest";

import { createRegistrationAdminWhatsAppRoutes } from "../../src/modules/registration/admin-review-whatsapp.js";

function viewRoute(dependencies: unknown) {
  const route = createRegistrationAdminWhatsAppRoutes(dependencies as never).find(
    (candidate) => candidate.command === "verficha",
  );
  if (route === undefined) throw new Error("/verficha route is missing");
  return route;
}

function context(input: {
  mentions?: readonly string[];
  replyToExternalMessageId?: string | null;
}) {
  return {
    idempotencyKey: "admin-verficha-mention",
    correlationId: "00000000-0000-4000-8000-000000000001",
    message: {
      provider: "baileys",
      senderRef: "5511888888888@s.whatsapp.net",
      chatRef: "120000000000000001@g.us",
      text: "/verficha",
      mentions: input.mentions ?? [],
      replyToExternalMessageId: input.replyToExternalMessageId ?? null,
    },
  } as never;
}

describe("/verficha mention lookup", () => {
  it("resolves one mention through the latest pending-review lookup instead of requiring a reply", async () => {
    const findLatestSubmittedReviewByIdentity = vi.fn(async () => null);
    const findByProviderMessage = vi.fn(async () => null);
    const route = viewRoute({
      messageRefs: { findByProviderMessage },
      reviewTargets: { findLatestSubmittedReviewByIdentity },
      admins: {},
      registration: {},
    });

    const result = await route.handler.handle(
      context({ mentions: ["5511999999999@s.whatsapp.net"] }),
    );

    expect(findLatestSubmittedReviewByIdentity).toHaveBeenCalledWith({
      provider: "baileys",
      externalId: "5511999999999@s.whatsapp.net",
    });
    expect(findByProviderMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing pending review");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.details?.userMessage).toBe(
      "Essa pessoa não tem ficha pendente para revisão.",
    );
  });

  it("keeps reply lookup as the fallback when there is no mention", async () => {
    const findLatestSubmittedReviewByIdentity = vi.fn(async () => null);
    const findByProviderMessage = vi.fn(async () => null);
    const route = viewRoute({
      messageRefs: { findByProviderMessage },
      reviewTargets: { findLatestSubmittedReviewByIdentity },
      admins: {},
      registration: {},
    });

    const result = await route.handler.handle(
      context({ replyToExternalMessageId: "wamid.review-notification" }),
    );

    expect(findLatestSubmittedReviewByIdentity).not.toHaveBeenCalled();
    expect(findByProviderMessage).toHaveBeenCalledWith({
      provider: "baileys",
      providerExternalMessageId: "wamid.review-notification",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing reply anchor");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("rejects ambiguous multi-mention reads before any lookup", async () => {
    const findLatestSubmittedReviewByIdentity = vi.fn(async () => null);
    const findByProviderMessage = vi.fn(async () => null);
    const route = viewRoute({
      messageRefs: { findByProviderMessage },
      reviewTargets: { findLatestSubmittedReviewByIdentity },
      admins: {},
      registration: {},
    });

    const result = await route.handler.handle(
      context({
        mentions: ["5511999999999@s.whatsapp.net", "5511777777777@s.whatsapp.net"],
      }),
    );

    expect(findLatestSubmittedReviewByIdentity).not.toHaveBeenCalled();
    expect(findByProviderMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
