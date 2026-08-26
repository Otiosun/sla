export interface MoveSlotView {
  readonly slotNo: number;
  readonly moveId: string;
}

export function firstFreeMoveSlot(slots: readonly MoveSlotView[]): number | null {
  const occupied = new Set(slots.map((slot) => slot.slotNo));
  for (let slotNo = 1; slotNo <= 4; slotNo += 1) {
    if (!occupied.has(slotNo)) return slotNo;
  }
  return null;
}

export function knowsMove(slots: readonly MoveSlotView[], moveId: string): boolean {
  return slots.some((slot) => slot.moveId === moveId);
}
