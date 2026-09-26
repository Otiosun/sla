export function normalizeHumanText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ");
}

export function parseMenuNumber(value: string): number | null {
  const normalized = value.trim();
  if (!/^0*[0-9]+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function parseCollectionNumber(value: string): number | null {
  const normalized = value.trim().replace(/^#/u, "");
  if (!/^[0-9]+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function parsePositiveQuantity(value: string): bigint | null {
  const normalized = normalizeHumanText(value);
  const patterns = [
    /^([0-9]+)$/u,
    /^([0-9]+)\s*x$/u,
    /^x\s*([0-9]+)$/u,
    /^quero\s+([0-9]+)(?:\s+unidades?)?$/u,
    /^([0-9]+)\s+unidades?$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const raw = match?.[1];
    if (raw === undefined) continue;
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : null;
  }
  return null;
}

export function parseBinaryConfirmation(value: string): boolean | null {
  const normalized = normalizeHumanText(value);
  if (["1", "01", "sim", "s", "confirmar", "confirmo", "ok"].includes(normalized)) return true;
  if (["2", "02", "nao", "n", "cancelar", "cancela"].includes(normalized)) return false;
  return null;
}

export function parseBoxSlot(value: string): { boxNo: number; slotNo: number } | null {
  const normalized = normalizeHumanText(value);
  const match = /^(?:caixa\s*)?([0-9]+)\s*(?:\/|,|\s+slot\s+|\s+)\s*([0-9]+)$/u.exec(normalized);
  if (match === null) return null;
  const boxNo = Number(match[1]);
  const slotNo = Number(match[2]);
  if (!Number.isSafeInteger(boxNo) || boxNo < 1) return null;
  if (!Number.isSafeInteger(slotNo) || slotNo < 1 || slotNo > 30) return null;
  return { boxNo, slotNo };
}

export function isLikelyMechanicalCommand(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("$");
}
