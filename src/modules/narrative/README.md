# Narrative AI N0

Phase 14 intentionally keeps narrative assistance outside mechanical authority.

- `NarrativeContextBuilder` accepts only an allowlisted safe-state shape plus already-legal actions.
- `NarrativeInterpreter` is provider-neutral. Cloud, free-tier, or local adapters can implement the same port.
- Provider output is versioned, budgeted, timed out, circuit-broken, schema-validated, and checked against the exact legal action set.
- N0 output always carries `mechanicalAuthority: "NONE"`; it cannot write the database or resolve damage, hit, capture, XP, rewards, persistent status, or ownership.
- Provider failures, malformed output, hallucinated references, quota, timeout, offline state, and low confidence return a safe fallback instead of blocking gameplay.
- `CanonicalNarrativeRenderer` renders only mechanical events already resolved by owners. The provider is not allowed to rewrite those results.
- User prose is a data field inside a fixed request envelope; no tool surface or mutation capability is exposed to the interpreter.
- Telemetry records only provider/outcome/duration metadata, never prompts or narrative context.
- N1 is preserved in `n1-spec.ts` as disabled allowlisted affordances for future work.
