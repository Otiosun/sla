export const NARRATIVE_N1_SPECIFICATION = {
  enabled: false,
  version: "draft-1",
  purpose: "Post-slice allowlisted affordances only; never direct mechanical authority.",
  allowlistedAffordances: [
    "reference-environment",
    "request-clarification",
    "suggest-legal-action-label",
  ],
  forbiddenAuthority: [
    "damage",
    "hit-or-miss",
    "capture-result",
    "xp-or-reward",
    "persistent-status",
    "ownership",
    "database-write",
  ],
} as const;
