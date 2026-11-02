import type { MessageHandlerResult } from "../messaging/contracts.js";

/** Shared response for first canonical capture and a verified post-commit replay. */
export function expeditionCaptureConfirmation(input: {
  readonly destinationRef: string;
  readonly encounterId: string;
  readonly status: "CAPTURED" | "FAILED";
  readonly idempotencyKey: string;
}): MessageHandlerResult {
  const lines =
    input.status === "CAPTURED"
      ? ["✨ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗔𝗣𝗧𝗨𝗥𝗔*", "> _Pokémon capturado e registrado pelo sistema canônico._"]
      : ["◇ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗔𝗣𝗧𝗨𝗥𝗔*", "> _Poké Ball lançada. O Pokémon escapou._"];
  return {
    resultRefType: "ENCOUNTER",
    resultRefId: input.encounterId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: input.destinationRef,
        messageType: "TEXT",
        payload: { text: lines.join("\n") },
        idempotencyKey: `${input.idempotencyKey}:expedition-canonical-capture`,
      },
    ],
  };
}
