import { type PokemonInstanceId, parsePokemonInstanceId } from "../../shared-kernel/ids.js";
import { parseBoxSlot, parseMenuNumber } from "../messaging/human-input.js";
import type { PokemonPcPokemonView, PokemonPcStorageSnapshot } from "./pc-storage-service.js";

const LIST_SUFFIX = ":center:pc:organize:list";
const DESTINATION_PREFIX = ":center:pc:organize:destination:";
const CONFIRM_PREFIX = ":center:pc:organize:confirm:";

export interface PokemonPcOrganizeDestination {
  readonly boxNo: number;
  readonly slotNo: number;
}

export interface PokemonPcOrganizeConfirmation extends PokemonPcOrganizeDestination {
  readonly pokemonInstanceId: PokemonInstanceId;
}

function sortedStoredPokemon(snapshot: PokemonPcStorageSnapshot): readonly PokemonPcPokemonView[] {
  return snapshot.boxes
    .flatMap((box) => box.pokemon)
    .sort((left, right) => {
      const boxDifference = (left.boxNo ?? 0) - (right.boxNo ?? 0);
      return boxDifference !== 0 ? boxDifference : left.slotNo - right.slotNo;
    });
}

export function isPcOrganizeListPromptKey(value: string): boolean {
  return value.endsWith(LIST_SUFFIX);
}

export function pcOrganizeStoredPokemonByCode(
  snapshot: PokemonPcStorageSnapshot,
  reply: string,
): PokemonPcPokemonView | null {
  const choice = parseMenuNumber(reply);
  if (choice === null) return null;
  const index = choice - 1;
  return sortedStoredPokemon(snapshot)[index] ?? null;
}

export function pcOrganizeStoredPokemonById(
  snapshot: PokemonPcStorageSnapshot,
  pokemonInstanceId: PokemonInstanceId,
): PokemonPcPokemonView | null {
  return (
    sortedStoredPokemon(snapshot).find(
      (pokemon) => pokemon.pokemonInstanceId === pokemonInstanceId,
    ) ?? null
  );
}

export function pcOrganizeDestinationPromptSuffix(pokemonInstanceId: PokemonInstanceId): string {
  return `${DESTINATION_PREFIX}${pokemonInstanceId}`;
}

export function pcOrganizePokemonFromDestinationPromptKey(value: string): PokemonInstanceId | null {
  const markerIndex = value.lastIndexOf(DESTINATION_PREFIX);
  if (markerIndex < 0) return null;
  const parsed = parsePokemonInstanceId(value.slice(markerIndex + DESTINATION_PREFIX.length));
  return parsed.ok ? parsed.value : null;
}

export function parsePcOrganizeDestinationReply(
  value: string,
): PokemonPcOrganizeDestination | null {
  return parseBoxSlot(value);
}

export function pcOrganizeConfirmPromptSuffix(
  pokemonInstanceId: PokemonInstanceId,
  destination: PokemonPcOrganizeDestination,
): string {
  return `${CONFIRM_PREFIX}${pokemonInstanceId}:${destination.boxNo}:${destination.slotNo}`;
}

export function pcOrganizeConfirmationFromPromptKey(
  value: string,
): PokemonPcOrganizeConfirmation | null {
  const markerIndex = value.lastIndexOf(CONFIRM_PREFIX);
  if (markerIndex < 0) return null;
  const parts = value.slice(markerIndex + CONFIRM_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [rawPokemonId, rawBoxNo, rawSlotNo] = parts;
  if (rawPokemonId === undefined || rawBoxNo === undefined || rawSlotNo === undefined) return null;
  const pokemon = parsePokemonInstanceId(rawPokemonId);
  if (!pokemon.ok) return null;
  const destination = parsePcOrganizeDestinationReply(`${rawBoxNo} / ${rawSlotNo}`);
  if (destination === null) return null;
  return { pokemonInstanceId: pokemon.value, ...destination };
}
