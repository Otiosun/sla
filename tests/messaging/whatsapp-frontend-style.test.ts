import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("WhatsApp frontend style contract", () => {
  it("records typography, Rotom protection and narrated exploration", () => {
    const guide = fs.readFileSync("docs/integration/FRONTEND_WHATSAPP_STYLE.md", "utf8");
    expect(guide).toContain("`*texto*`");
    expect(guide).toContain("`_texto_`");
    expect(guide).toContain("monoespaçado");
    expect(guide).toContain("Exploração não é grind automático");
    expect(guide).toContain("foto + legenda decorada");
  });
});
