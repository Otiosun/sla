import type { FishingAttemptResult, FishingRarity } from "./fishing-service.js";

const RARITY_LABEL: Readonly<Record<FishingRarity, string>> = {
  COMMON: "◇ *𝗖𝗢𝗠𝗨𝗠*",
  UNCOMMON: "◆ *𝗜𝗡𝗖𝗢𝗠𝗨𝗠*",
  RARE: "✦ *𝗥𝗔𝗥𝗢*",
  EXTREMELY_RARE: "✧ *𝗘𝗫𝗧𝗥𝗘𝗠𝗔𝗠𝗘𝗡𝗧𝗘 𝗥𝗔𝗥𝗢*",
};

function attemptPips(remaining: number, limit: number): string {
  const boundedLimit = Math.max(0, Math.min(limit, 10));
  const boundedRemaining = Math.max(0, Math.min(remaining, boundedLimit));
  return Array.from({ length: boundedLimit }, (_, index) =>
    index < boundedRemaining ? "●" : "○",
  ).join(" ");
}

function styledUpper(value: string): string {
  return [...value.toUpperCase()]
    .map((character) => {
      const code = character.codePointAt(0);
      if (code === undefined || code < 65 || code > 90) return character;
      return String.fromCodePoint(0x1d5d4 + code - 65);
    })
    .join("");
}

export function renderFishingCast(result: FishingAttemptResult): string {
  return [
    `⌁ *𝗥𝗜𝗢 𝗗𝗢𝗦 𝗔𝗥𝗥𝗢𝗭𝗔𝗜𝗦*`,
    "　🎣 Ponto de Pesca",
    "",
    "> _Você lança a linha e permanece em silêncio enquanto observa a superfície do rio._",
    "",
    "🎣 *Tentativas de hoje*",
    `\`${attemptPips(result.remainingAttempts, result.dailyLimit)}\`　*${result.remainingAttempts}/${result.dailyLimit}*`,
    "",
    "　　　　　≋　○　≋",
  ].join("\n");
}

export function renderFishingBite(): string {
  return [
    "　　　　　≋　●　≋",
    "　　　　　　❗",
    "　　*𝗔 𝗕𝗢𝗜𝗔 𝗔𝗙𝗨𝗡𝗗𝗢𝗨!*",
    "",
    "> _A vara se curva. Algo está puxando a linha._",
  ].join("\n");
}

export function renderFishingEncounter(
  result: FishingAttemptResult,
  speciesDisplayName: string,
): string {
  if (result.rarity === null || result.encounter === null) {
    throw new Error("Fishing encounter renderer requires an encounter result");
  }
  const displayName = speciesDisplayName.trim();
  if (displayName.length === 0) {
    throw new Error("Fishing encounter renderer requires a species display name");
  }

  return [
    `🎲 D20 · \`${result.roll}\``,
    "",
    `　　　　　${RARITY_LABEL[result.rarity]}`,
    "",
    `　　　　　*${styledUpper(displayName)}*`,
    `　　　　　　Nv. \`${String(result.encounter.snapshot.level).padStart(2, "0")}\``,
    "",
    `⌖ Local · *${result.fishingPointName}*`,
    `🎣 Restantes · \`${result.remainingAttempts}/${result.dailyLimit}\``,
    "",
    "> _Depois de alguns instantes de resistência, você consegue puxá-lo para fora da água._",
    "",
    "　　　⧉ *𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢 𝗜𝗡𝗜𝗖𝗜𝗔𝗗𝗢*",
  ].join("\n");
}

export function renderFishingNoEncounter(result: FishingAttemptResult): string {
  return [
    `🎲 D20 · \`${result.roll}\``,
    "",
    "　　　　　○ *𝗡𝗔𝗗𝗔 𝗠𝗢𝗥𝗗𝗘𝗨*",
    "",
    `⌖ Local · *${result.fishingPointName}*`,
    `🎣 Restantes · \`${result.remainingAttempts}/${result.dailyLimit}\``,
    "",
    "> _A linha permanece imóvel. Depois de alguns instantes, você recolhe a isca sem encontrar nenhum Pokémon._",
  ].join("\n");
}
