export const VILA_DOS_ARROZAIS_SLUG = "vila-dos-arrozais";

export const VILA_DOS_ARROZAIS_FIRST_ARRIVAL = [
  "〘 🌾 VILA DOS ARROZAIS 〙",
  "",
  "Uma pequena vila surge entre extensos arrozais, canais de irrigação e campos verdes.",
  "",
  "Casas simples se agrupam próximas ao rio, enquanto caminhos de terra seguem entre plantações e pequenos bosques.",
  "",
  "Mais adiante, o rio se divide em diversos canais que atravessam toda a região.",
  "",
  "Apesar da tranquilidade, barreiras construídas contra as enchentes revelam que nem tudo permanece tão estável quanto parece.",
  "",
  "📍 VOCÊ CHEGOU — VILA DOS ARROZAIS",
].join("\n");

export const VILA_DOS_ARROZAIS_RETURN = [
  "〘 🌾 VILA DOS ARROZAIS 〙",
  "",
  "Os canais voltam a surgir ao lado da estrada. Mais adiante, telhados baixos aparecem entre os campos inundados.",
  "",
  "📍 VOCÊ RETORNOU — VILA DOS ARROZAIS",
].join("\n");

export function zhouliaArrivalCaption(areaSlug: string, firstVisit: boolean): string | null {
  if (areaSlug !== VILA_DOS_ARROZAIS_SLUG) return null;
  return firstVisit ? VILA_DOS_ARROZAIS_FIRST_ARRIVAL : VILA_DOS_ARROZAIS_RETURN;
}
