import { describe, expect, it } from "vitest";
import { RegistrationReviewMentionResolver } from "../../src/modules/registration/review-mentions.js";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "22222222-2222-4222-8222-222222222222";
const STAFF_B = "33333333-3333-4333-8333-333333333333";

describe("RegistrationReviewMentionResolver", () => {
  it("returns only capability-validated WhatsApp JIDs assigned to the active Reception", async () => {
    const resolver = new RegistrationReviewMentionResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: GROUP_ID,
          role: "RECEPTION" as const,
          capabilities: ["onboarding", "admin.review"] as const,
        }),
        listReceptionStaff: async () => [STAFF_B, STAFF_A],
      },
      admins: {
        whatsAppJidsForPrincipals: async (input: {
          readonly principalIds: readonly string[];
          readonly requiredCapability: string;
        }) => {
          expect(input).toEqual({
            principalIds: [STAFF_A, STAFF_B],
            requiredCapability: "player.registration.read",
          });
          return ["5511888888888@s.whatsapp.net", "5511999999999@s.whatsapp.net"];
        },
      },
    });

    expect(
      await resolver.mentionsFor({
        provider: "baileys",
        chatRef: "120363000000000001@g.us",
      }),
    ).toEqual(["5511888888888@s.whatsapp.net", "5511999999999@s.whatsapp.net"]);
  });

  it("returns no mentions for unknown, non-Reception or non-review-capable groups", async () => {
    let staffReads = 0;
    let adminReads = 0;
    const resolver = new RegistrationReviewMentionResolver({
      community: {
        resolveChat: async () => ({
          known: true,
          groupId: GROUP_ID,
          role: "RECEPTION" as const,
          capabilities: ["onboarding"] as const,
        }),
        listReceptionStaff: async () => {
          staffReads += 1;
          return [STAFF_A];
        },
      },
      admins: {
        whatsAppJidsForPrincipals: async () => {
          adminReads += 1;
          return ["5511999999999@s.whatsapp.net"];
        },
      },
    });

    expect(await resolver.mentionsFor({ provider: "baileys", chatRef: "reception@g.us" })).toEqual(
      [],
    );
    expect(staffReads).toBe(0);
    expect(adminReads).toBe(0);
  });
});
