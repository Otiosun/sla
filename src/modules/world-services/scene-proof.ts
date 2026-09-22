export const MIN_SCENE_PROOF_WORDS = 50;

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const COMMAND_TOKEN_PATTERN = /\/[\p{L}\p{N}_-]+/gu;

export function sceneProofWordCount(text: string): number {
  return text.replace(COMMAND_TOKEN_PATTERN, " ").match(WORD_PATTERN)?.length ?? 0;
}

export function qualifiesAsSceneProof(text: string): boolean {
  return sceneProofWordCount(text) >= MIN_SCENE_PROOF_WORDS;
}
