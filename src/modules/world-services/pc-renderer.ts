import type { PokemonPcStorageSnapshot } from "./pc-storage-service.js";

function formatPcNumber(value: number): string {
  return value.toString().padStart(2, "0");
}

export function renderPokemonPcDepositSelection(snapshot: PokemonPcStorageSnapshot): string {
  const team = [...snapshot.team].sort((left, right) => left.slotNo - right.slotNo);
  const lines = [
    "↓ *𝗗𝗘𝗣𝗢𝗦𝗜𝗧𝗔𝗥 𝗣𝗢𝗞É𝗠𝗢𝗡*",
    "　PC Pokémon · Equipe atual",
    "",
    "> _Escolha qual Pokémon deseja enviar para uma das caixas._",
    "",
    "◇ *𝗘𝗤𝗨𝗜𝗣𝗘*",
  ];

  for (const pokemon of team) {
    lines.push(
      `\`${formatPcNumber(pokemon.slotNo)}\` ${pokemon.displayName} · Nv. \`${formatPcNumber(pokemon.level)}\``,
    );
  }

  lines.push(
    "",
    "△ _Ao menos um Pokémon deve permanecer na equipe._",
    "",
    "› _Responda com o número do Pokémon._",
  );
  return lines.join("\n");
}
