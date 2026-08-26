import { StateMachine } from "../../shared-kernel/state-machine.js";
import type { EncounterStatus } from "./contracts.js";

export const encounterStateMachine = new StateMachine<EncounterStatus>({
  CREATED: ["PRESENTED", "FLED", "EXPIRED", "CLOSED"],
  PRESENTED: ["ENGAGED", "FLED", "EXPIRED", "CLOSED"],
  ENGAGED: ["IN_BATTLE", "CAPTURE_RESOLVING", "FLED", "EXPIRED", "CLOSED"],
  CAPTURE_RESOLVING: ["IN_BATTLE", "ENGAGED", "CAPTURED", "CLOSED"],
  IN_BATTLE: ["CAPTURE_RESOLVING", "CAPTURED", "FLED", "CLOSED"],
  CAPTURED: ["CLOSED"],
  FLED: ["CLOSED"],
  EXPIRED: ["CLOSED"],
  CLOSED: [],
});

export const encounterTerminalStatuses = new Set<EncounterStatus>([
  "CAPTURED",
  "FLED",
  "EXPIRED",
  "CLOSED",
]);
