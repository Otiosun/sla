import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { normalizeHumanText, parseCollectionNumber } from "./human-input.js";
import type { OperationalOwnedPokemonView } from "./operational-ux-read-model.js";

export function resolveOwnedPokemonReference(
  owned: readonly OperationalOwnedPokemonView[],
  rawReference: string,
): Result<OperationalOwnedPokemonView> {
  const collectionNo = parseCollectionNumber(rawReference);
  if (collectionNo !== null) {
    const byNumber = owned.find((entry) => entry.collectionNo === collectionNo);
    return byNumber === undefined
      ? err(appError("NOT_FOUND", "Não existe um Pokémon com esse número na sua coleção."))
      : ok(byNumber);
  }

  const normalized = normalizeHumanText(rawReference);
  if (normalized.length === 0) {
    return err(
      appError(
        "VALIDATION_FAILED",
        "Informe o Pokémon por número da coleção ou nome. Ex.: `/pokemon #13`.",
      ),
    );
  }

  const matches = owned.filter((entry) => {
    const displayName = normalizeHumanText(entry.displayName);
    const nickname = entry.nickname === null ? "" : normalizeHumanText(entry.nickname);
    return normalized === displayName || (nickname.length > 0 && normalized === nickname);
  });
  if (matches.length === 0) {
    return err(
      appError(
        "NOT_FOUND",
        "Não encontrei esse Pokémon na sua coleção. Use `/colecao` para conferir os números.",
      ),
    );
  }
  if (matches.length > 1) {
    const options = matches.map((entry) => `#${String(entry.collectionNo)}`).join(", ");
    return err(
      appError(
        "VALIDATION_FAILED",
        `Há mais de um Pokémon com esse nome. Use o número da coleção: ${options}.`,
      ),
    );
  }

  const match = matches[0];
  return match === undefined
    ? err(appError("NOT_FOUND", "Não encontrei esse Pokémon na sua coleção."))
    : ok(match);
}
