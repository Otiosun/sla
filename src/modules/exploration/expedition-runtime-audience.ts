import { AsyncLocalStorage } from "node:async_hooks";

// The operational entry point installs a scope even for a denied player, so
// isolated test settings cannot grant access inside an operational dispatch.
const audience = new AsyncLocalStorage<string | null>();

export function withExpeditionAudience<T>(playerId: string | null, work: () => T): T {
  return audience.run(playerId, work);
}

export function expeditionOperationAllowed(playerId?: string): boolean {
  const current = audience.getStore();
  if (current !== undefined)
    return current !== null && (playerId === undefined || current === playerId);
  return (
    process.env.APP_ENV === "test" &&
    process.env.NODE_ENV === "test" &&
    process.env.WHATSAPP_ENABLED === "false"
  );
}
