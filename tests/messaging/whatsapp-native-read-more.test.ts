import { describe, expect, it } from "vitest";
import {
  renderWhatsAppNativeReadMore,
  WHATSAPP_READ_MORE_COMBINING_CHARACTER,
} from "../../src/modules/messaging/whatsapp-native-read-more.js";

describe("WhatsApp native fold, opt-in and presentation-only", () => {
  const visible = "STATUS: ACTIVE";
  const expanded = "1. Buscar\n2. Recursos\n3. Viajar\n4. Encerrar";
  const base = visible + "\n\n" + expanded;

  it("uses the exact U+031D combining character as an opt-in spacer", () => {
    const result = renderWhatsAppNativeReadMore({ visible, expanded, combiningCount: 650 });
    expect(result).toMatchObject({ padded: true, reason: "APPLIED" });
    expect(result.text).toBe(
      visible + "\n\n" + WHATSAPP_READ_MORE_COMBINING_CHARACTER.repeat(650) + "\n\n" + expanded,
    );
    expect(result.text).not.toContain("[Ler mais]");
  });

  it("does not change gameplay commands when calibration is not available", () => {
    expect(renderWhatsAppNativeReadMore({ visible, expanded, combiningCount: 0 })).toEqual({
      text: base,
      padded: false,
      reason: "UNCALIBRATED",
    });
  });

  it("preserves the full menu if a caption budget cannot fit padding", () => {
    const result = renderWhatsAppNativeReadMore({
      visible,
      expanded,
      combiningCount: 650,
      maxCodeUnits: 100,
    });
    expect(result).toMatchObject({ padded: false, reason: "OVER_LIMIT" });
    expect(result.text).toBe(base);
  });

  it("never exposes editorial prototype separators to a player", () => {
    const result = renderWhatsAppNativeReadMore({
      visible,
      expanded: "[Ler mais]\n" + expanded,
      combiningCount: 650,
    });
    expect(result.reason).toBe("INVALID_CONTENT");
    expect(result.text).not.toContain("[Ler mais]");
    expect(result.text).toContain("4. Encerrar");
  });

  it("does not allocate invalid or extremely long padding", () => {
    for (const n of [-1, 0, 0.1, Infinity, Number.MAX_SAFE_INTEGER, 16385]) {
      const result = renderWhatsAppNativeReadMore({ visible, expanded, combiningCount: n });
      expect(result.text).toBe(base);
      expect(result.padded).toBe(false);
    }
  });

  it("refuses empty headers or action sets", () => {
    expect(renderWhatsAppNativeReadMore({ visible: "", expanded, combiningCount: 10 }).padded).toBe(
      false,
    );
    expect(renderWhatsAppNativeReadMore({ visible, expanded: "", combiningCount: 10 }).padded).toBe(
      false,
    );
  });
});
