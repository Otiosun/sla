import type { PlayerId } from "../../shared-kernel/ids.js";

export const REGISTRATION_CONVERSATION_FIELDS = [
  "trainerName",
  "age",
  "genderPronouns",
  "appearance",
  "personality",
  "backstory",
  "starterFormId",
] as const;

export type RegistrationConversationField = (typeof REGISTRATION_CONVERSATION_FIELDS)[number];
export type RegistrationConversationEditingMode = "GUIDED" | "FULL";
export type RegistrationConversationState =
  | "MODE_SELECT"
  | "GUIDED_FIELD"
  | "FULL_FORM"
  | "REVIEW"
  | "EDIT_SELECT"
  | "EDIT_FIELD"
  | "PAUSED"
  | "RESUME_MENU"
  | "RESTART_CONFIRM"
  | "WITHDRAW_CONFIRM"
  | "SUBMITTED";

export interface RegistrationConversationRecord {
  readonly playerId: PlayerId;
  readonly chatRef: string;
  readonly state: RegistrationConversationState;
  readonly editingMode: RegistrationConversationEditingMode | null;
  readonly currentField: RegistrationConversationField | null;
  readonly editField: RegistrationConversationField | null;
  readonly activePromptOutboxIdempotencyKey: string | null;
  readonly draftRevision: number | null;
  readonly lastInboxMessageId: string | null;
  readonly flowVersion: 2;
  readonly revision: number;
}

export function registrationConversationInvariant(record: RegistrationConversationRecord): boolean {
  if (record.chatRef.trim().length === 0 || record.revision < 0) return false;
  if (record.state === "GUIDED_FIELD") {
    return record.editingMode === "GUIDED" && record.currentField !== null;
  }
  if (record.state === "FULL_FORM") return record.editingMode === "FULL";
  if (record.state === "EDIT_FIELD") return record.editField !== null;
  if (
    record.state === "PAUSED" ||
    record.state === "WITHDRAW_CONFIRM" ||
    record.state === "SUBMITTED"
  ) {
    return record.activePromptOutboxIdempotencyKey === null;
  }
  return true;
}
