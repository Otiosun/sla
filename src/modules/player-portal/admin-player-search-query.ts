const PLAYER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BAILEYS_PHONE_JID_PATTERN = /^(\d{10,15})@s\.whatsapp\.net$/i;

export type AdminPlayerSearchQueryKind = "EMPTY" | "PLAYER_ID" | "WHATSAPP" | "TRAINER_NAME";

export type AdminPlayerSearchQuery =
  | { readonly kind: "EMPTY" }
  | { readonly kind: "PLAYER_ID"; readonly playerId: string }
  | {
      readonly kind: "WHATSAPP";
      readonly identityProvider: "baileys";
      readonly externalId: string;
    }
  | { readonly kind: "TRAINER_NAME"; readonly trainerNamePrefix: string };

export function normalizeAdminPlayerWhatsAppExternalId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const canonical = trimmed.match(BAILEYS_PHONE_JID_PATTERN);
  if (canonical?.[1] !== undefined) {
    return `${canonical[1]}@s.whatsapp.net`;
  }

  if (!/^[+\d() .-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return `${digits}@s.whatsapp.net`;
}

export function classifyAdminPlayerSearchQuery(value: string | null): AdminPlayerSearchQuery {
  const query = value?.trim() ?? "";
  if (query.length === 0) return { kind: "EMPTY" };

  if (PLAYER_UUID_PATTERN.test(query)) {
    return { kind: "PLAYER_ID", playerId: query };
  }

  const externalId = normalizeAdminPlayerWhatsAppExternalId(query);
  if (externalId !== null) {
    return {
      kind: "WHATSAPP",
      identityProvider: "baileys",
      externalId,
    };
  }

  return { kind: "TRAINER_NAME", trainerNamePrefix: query };
}
