import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  fetchLatestWaWebVersion,
  initAuthCreds,
  normalizeMessageContent,
  proto,
} from "@whiskeysockets/baileys";

export const loggedOutStatusCode = DisconnectReason.loggedOut;
export { fetchLatestWaWebVersion, normalizeMessageContent };
export const makeSocket = (config) => makeWASocket(config);
export const createInitialAuthCreds = () => initAuthCreds();
export const serializeAuthValue = (value) => JSON.stringify(value, BufferJSON.replacer);
export const deserializeAuthValue = (serialized, keyType = null) => {
  const value = JSON.parse(serialized, BufferJSON.reviver);
  if (keyType === "app-state-sync-key" && value !== null && value !== undefined) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
};
