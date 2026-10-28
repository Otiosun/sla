import { describe, expect, it } from "vitest";
import { purchasableMartItems } from "../../src/modules/world-services/mart-published-offers.js";
import { renderMartCatalog, renderMartItemSelection } from "../../src/modules/world-services/renderer.js";

describe("Poké Mart published-offer storefront", () => {
  it("shows only true published offers at their actual published prices", () => {
    const available = purchasableMartItems([
      { offerKey: "shop.poke-ball", itemQuantity: 1n, priceAmount: 275n },
      { offerKey: "shop.potion", itemQuantity: 1n, priceAmount: 320n },
    ]);
    expect(available.map((offer) => offer.offerKey)).toEqual(["shop.poke-ball", "shop.potion"]);
    expect(available.map((offer) => offer.unitPrice)).toEqual([275n, 320n]);
    const displayed = renderMartCatalog(available);
    expect(displayed).toContain("Poké Ball");
    expect(displayed).toContain("Potion");
    expect(displayed).toContain("₽275");
    expect(displayed).toContain("₽320");
    expect(displayed).not.toContain("Great Ball");
    expect(displayed).not.toContain("Repel");
    expect(renderMartItemSelection(available[0]!)).toContain("₽275");
  });

  it("rejects package offers not represented by the one-item checkout UI", () => {
    expect(purchasableMartItems([
      { offerKey: "shop.poke-ball", itemQuantity: 5n, priceAmount: 900n },
      { offerKey: "shop.potion", itemQuantity: 1n, priceAmount: 0n },
      { offerKey: "shop.fake-stone", itemQuantity: 1n, priceAmount: 900n },
    ])).toEqual([]);
    expect(renderMartCatalog([])).toContain("Nenhuma mercadoria disponível");
    expect(renderMartCatalog([])).not.toContain("› _Responda com o número da mercadoria._");
  });

  it("includes only real published evolution stones and TMs beyond the legacy shelf", () => {
    const items = purchasableMartItems([
      { offerKey: "shop.tm-electric", itemQuantity: 1n, priceAmount: 1500n,
        displayName: "TM Electric", itemKind: "TM" },
      { offerKey: "shop.thunder-stone", itemQuantity: 1n, priceAmount: 2500n,
        displayName: "Thunder Stone", itemKind: "EVOLUTION" },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ displayName: "Thunder Stone", category: "EVOLUTION", code: "17" }),
      expect.objectContaining({ displayName: "TM Electric", category: "TM", code: "18" }),
    ]);
    const text = renderMartCatalog(items);
    expect(text).toContain("Thunder Stone");
    expect(text).toContain("TM Electric");
    expect(text).toContain("₽2.500");
    expect(text).toContain("₽1.500");
  });
});
