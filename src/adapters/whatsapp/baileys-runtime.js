import makeWASocket, {
  DisconnectReason,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";

export const loggedOutStatusCode = DisconnectReason.loggedOut;
export { normalizeMessageContent };
export const makeSocket = (config) => makeWASocket(config);
