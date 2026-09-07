import type { PokemonInstanceId } from "../../shared-kernel/ids.js";
import type { PokemonPcPokemonView, PokemonPcStorageSnapshot } from "./pc-storage-service.js";

const BOX_CAPACITY = 30;
const PC_DEPOSIT_LIST_SUFFIX = ":center:pc:deposit:list";
const PC_DEPOSIT_CONFIRM_PREFIX = ":center:pc:deposit:confirm:";

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
