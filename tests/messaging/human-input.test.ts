import { describe, expect, it } from "vitest";
import {
  parseBinaryConfirmation,
  parseBoxSlot,
  parseCollectionNumber,
  parseMenuNumber,
  parsePositiveQuantity,
} from "../../src/modules/messaging/human-input.js";

describe("human WhatsApp input", () => {
  it("normalizes numbered menu and collection references", () => {
    expect(parseMenuNumber("01")).toBe(1);
    expect(parseMenuNumber("11")).toBe(11);
    expect(parseCollectionNumber("#13")).toBe(13);
    expect(parseCollectionNumber("13")).toBe(13);
  });

  it("accepts natural positive quantities", () => {
    expect(parsePositiveQuantity("5")).toBe(5n);
    expect(parsePositiveQuantity("5x")).toBe(5n);
    expect(parsePositiveQuantity("x5")).toBe(5n);
    expect(parsePositiveQuantity("quero 5")).toBe(5n);
    expect(parsePositiveQuantity("5 unidades")).toBe(5n);
  });

  it("accepts human confirmations and box destinations", () => {
    expect(parseBinaryConfirmation("sim")).toBe(true);
    expect(parseBinaryConfirmation("01")).toBe(true);
    expect(parseBinaryConfirmation("não")).toBe(false);
    expect(parseBinaryConfirmation("cancelar")).toBe(false);
    expect(parseBoxSlot("1/3")).toEqual({ boxNo: 1, slotNo: 3 });
    expect(parseBoxSlot("1 3")).toEqual({ boxNo: 1, slotNo: 3 });
    expect(parseBoxSlot("caixa 1 slot 3")).toEqual({ boxNo: 1, slotNo: 3 });
  });
});
