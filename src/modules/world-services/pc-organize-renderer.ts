import type { PokemonPcOrganizeDestination } from "./pc-organize-conversation.js";
import type {
  PokemonPcOrganizeApplied,
  PokemonPcPokemonView,
  PokemonPcStorageSnapshot,
} from "./pc-storage-service.js";

function formatPcNumber(value: number): string {
  return value.toString().padStart(2, "0");
}

function storedPokemon(snapshot: PokemonPcStorageSnapshot): readonly PokemonPcPokemonView[] {
  return snapshot.boxes
    .flatMap((box) => box.pokemon)
    .sort((left, right) => {
      const boxDifference = (left.boxNo ?? 0) - (right.boxNo ?? 0);
      return boxDifference !== 0 ? boxDifference : left.slotNo - right.slotNo;
    });
}

export function renderPokemonPcOrganizeSelection(snapshot: PokemonPcStorageSnapshot): string {
  const pokemon = storedPokemon(snapshot);
  const lines = [
    "↻ *𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗥 𝗖𝗔𝗜𝗫𝗔𝗦*",
    "　PC Pokémon · Armazenamento",
    "",
    "> _Escolha qual Pokémon armazenado deseja mover._",
    "",
  ];

  if (pokemon.length === 0) {
    lines.push("◇ *Nenhum Pokémon armazenado.*", "", "‹　`/pc`");
    return lines.join("\n");
  }

  pokemon.forEach((entry, index) => {
    lines.push(
      `\`${formatPcNumber(index + 1)}\` ${entry.displayName} · Nv. \`${formatPcNumber(entry.level)}\``,
      `　Caixa ${formatPcNumber(entry.boxNo ?? 1)} · Vaga ${formatPcNumber(entry.slotNo)}`,
    );
  });
  lines.push("", "› _Responda com o número do Pokémon._");
  return lines.join("\n");
}

export function renderPokemonPcOrganizeDestination(pokemon: PokemonPcPokemonView): string {
  return [
    "↻ *𝗡𝗢𝗩𝗢 𝗗𝗘𝗦𝗧𝗜𝗡𝗢*",
    "　PC Pokémon · Organização",
    "",
    `◇ *${pokemon.displayName}* · Nv. \`${formatPcNumber(pokemon.level)}\``,
    `　Atual · Caixa ${formatPcNumber(pokemon.boxNo ?? 1)} · Vaga ${formatPcNumber(pokemon.slotNo)}`,
    "",
    "▣ *Destino*",
    "`Caixa / Vaga`",
    "",
    "Exemplo · `2 / 5`",
    "",
    "› _Informe a caixa e a vaga desejadas._",
  ].join("\n");
}

export function renderPokemonPcOrganizeConfirmation(
  pokemon: PokemonPcPokemonView,
  destination: PokemonPcOrganizeDestination,
): string {
  return [
    "↻ *𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢*",
    "　PC Pokémon · Organização",
    "",
    `◇ *${pokemon.displayName}*`,
    `　Origem · Caixa ${formatPcNumber(pokemon.boxNo ?? 1)} · Vaga ${formatPcNumber(pokemon.slotNo)}`,
    `　Destino · Caixa ${formatPcNumber(destination.boxNo)} · Vaga ${formatPcNumber(destination.slotNo)}`,
    "",
    "`01` Confirmar",
    "`02` Cancelar",
    "",
    "› _Responda com o número da opção._",
  ].join("\n");
}

export function renderPokemonPcOrganizeSuccess(result: PokemonPcOrganizeApplied): string {
  return [
    "✓ *𝗖𝗔𝗜𝗫𝗔 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗗𝗔*",
    "　PC Pokémon · Movimento concluído",
    "",
    `▣ Origem · Caixa ${formatPcNumber(result.fromBoxNo)} · Vaga ${formatPcNumber(result.fromSlotNo)}`,
    `▣ Destino · Caixa ${formatPcNumber(result.toBoxNo)} · Vaga ${formatPcNumber(result.toSlotNo)}`,
    "",
    "> _O armazenamento foi atualizado._",
    "",
    "‹　`/pc`",
  ].join("\n");
}

export function renderPokemonPcOrganizeCancelled(): string {
  return [
    "‹ *𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢 𝗖𝗔𝗡𝗖𝗘𝗟𝗔𝗗𝗔*",
    "　PC Pokémon · Nenhuma alteração realizada",
    "",
    "> _O Pokémon permanece na posição atual._",
    "",
    "‹　`/pc`",
  ].join("\n");
}
