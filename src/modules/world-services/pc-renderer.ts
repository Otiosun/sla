import type { PokemonPcDepositDestinationPreview } from "./pc-conversation.js";
import type {
  PokemonPcPokemonView,
  PokemonPcStorageSnapshot,
} from "./pc-storage-service.js";

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

export function renderPokemonPcDepositConfirmation(
  pokemon: PokemonPcPokemonView,
  destination: PokemonPcDepositDestinationPreview,
): string {
  return [
    "↓ *𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢*",
    "　PC Pokémon · Transferência",
    "",
    `◇ *${pokemon.displayName}* · Nv. \`${formatPcNumber(pokemon.level)}\``,
    `　Equipe · Posição \`${formatPcNumber(pokemon.slotNo)}\``,
    "",
    "▣ *𝗗𝗘𝗦𝗧𝗜𝗡𝗢 𝗣𝗥𝗘𝗩𝗜𝗦𝗧𝗢*",
    `　Caixa ${formatPcNumber(destination.boxNo)} · Vaga ${formatPcNumber(destination.slotNo)}`,
    "",
    "> _O destino será revalidado no momento da transferência._",
    "",
    "`01` Confirmar",
    "`02` Cancelar",
    "",
    "› _Responda com o número da opção._",
  ].join("\n");
}
