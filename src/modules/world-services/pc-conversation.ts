import { parsePokemonInstanceId, type PokemonInstanceId } from "../../shared-kernel/ids.js";
import type { PokemonPcPokemonView, PokemonPcStorageSnapshot } from "./pc-storage-service.js";

const BOX_CAPACITY = 30;
const PC_DEPOSIT_LIST_SUFFIX = ":center:pc:deposit:list";
const PC_DEPOSIT_CONFIRM_PREFIX = ":center:pc:deposit:confirm:";
const PC_WITHDRAW_LIST_SUFFIX = ":center:pc:withdraw:list";
const PC_WITHDRAW_CONFIRM_PREFIX = ":center:pc:withdraw:confirm:";

export interface PokemonPcDepositDestinationPreview {
  readonly boxNo: number;
  readonly slotNo: number;
}

export function isPcDepositListPromptKey(value: string): boolean {
  return value.endsWith(PC_DEPOSIT_LIST_SUFFIX);
}

export function pcDepositConfirmPromptSuffix(pokemonInstanceId: PokemonInstanceId): string {
  return `${PC_DEPOSIT_CONFIRM_PREFIX}${pokemonInstanceId}`;
}

export function pcDepositPokemonFromConfirmPromptKey(value: string): PokemonInstanceId | null {
  const markerIndex = value.lastIndexOf(PC_DEPOSIT_CONFIRM_PREFIX);
  if (markerIndex < 0) return null;
  const rawPokemonInstanceId = value.slice(markerIndex + PC_DEPOSIT_CONFIRM_PREFIX.length);
  const parsed = parsePokemonInstanceId(rawPokemonInstanceId);
  return parsed.ok ? parsed.value : null;
}

export function pcTeamPokemonBySlot(
  snapshot: PokemonPcStorageSnapshot,
  reply: string,
): PokemonPcPokemonView | null {
  const normalized = reply.trim();
  if (!/^[0-9]{1,2}$/.test(normalized)) return null;
  const slotNo = Number(normalized);
  if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > 6) return null;
  return snapshot.team.find((pokemon) => pokemon.slotNo === slotNo) ?? null;
}

export function previewPcDepositDestination(
  snapshot: PokemonPcStorageSnapshot,
): PokemonPcDepositDestinationPreview {
  const occupied = new Set<string>();
  let highestBoxNo = 0;
  for (const box of snapshot.boxes) {
    highestBoxNo = Math.max(highestBoxNo, box.boxNo);
    for (const pokemon of box.pokemon) {
      occupied.add(`${box.boxNo}:${pokemon.slotNo}`);
    }
  }

  const maxCandidateBox = highestBoxNo + 1;
  for (let boxNo = 1; boxNo <= maxCandidateBox; boxNo += 1) {
    for (let slotNo = 1; slotNo <= BOX_CAPACITY; slotNo += 1) {
      if (!occupied.has(`${boxNo}:${slotNo}`)) return { boxNo, slotNo };
    }
  }

  return { boxNo: maxCandidateBox + 1, slotNo: 1 };
}

export function isPcWithdrawListPromptKey(value: string): boolean {
  return value.endsWith(PC_WITHDRAW_LIST_SUFFIX);
}

export function pcWithdrawConfirmPromptSuffix(pokemonInstanceId: PokemonInstanceId): string {
  return `${PC_WITHDRAW_CONFIRM_PREFIX}${pokemonInstanceId}`;
}

export function pcWithdrawPokemonFromConfirmPromptKey(value: string): PokemonInstanceId | null {
  const markerIndex = value.lastIndexOf(PC_WITHDRAW_CONFIRM_PREFIX);
  if (markerIndex < 0) return null;
  const rawPokemonInstanceId = value.slice(markerIndex + PC_WITHDRAW_CONFIRM_PREFIX.length);
  const parsed = parsePokemonInstanceId(rawPokemonInstanceId);
  return parsed.ok ? parsed.value : null;
}

export function pcStoredPokemonByCode(
  snapshot: PokemonPcStorageSnapshot,
  reply: string,
): PokemonPcPokemonView | null {
  const normalized = reply.trim();
  if (!/^[0-9]{1,2}$/.test(normalized)) return null;
  const selectedIndex = Number(normalized) - 1;
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) return null;

  const stored = snapshot.boxes
    .flatMap((box) => box.pokemon)
    .sort((left, right) => {
      const boxDifference = (left.boxNo ?? 0) - (right.boxNo ?? 0);
      return boxDifference !== 0 ? boxDifference : left.slotNo - right.slotNo;
    });
  return stored[selectedIndex] ?? null;
}
