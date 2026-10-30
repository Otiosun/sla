import { describe, expect, it } from "vitest";
import { renderWhatsAppNativeReadMore } from "../../src/modules/messaging/whatsapp-native-read-more.js";
describe("native fold", () => { it("keeps content when uncalibrated", () => { expect(renderWhatsAppNativeReadMore({ visible: "status", expanded: "options", combiningCount: 0 }).text).toBe("status\n\noptions"); }); });
