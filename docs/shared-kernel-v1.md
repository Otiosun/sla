# Shared Kernel v1

Phase 3 establishes contracts that every gameplay module must reuse instead of reimplementing.

## Contracts

- Domain IDs are branded nominal types (`PlayerId`, `PokemonInstanceId`, `BattleId`, `EncounterId`, and execution IDs).
- Expected domain failures use stable error codes through `Result`; human-readable messages are not API contracts.
- Time is accessed through an injectable `Clock`.
- Randomness is accessed through `RandomSource`; production uses CSPRNG and tests/replay can use deterministic seeded RNG.
- `CorrelationId` and `CausationId` are propagated as explicit causality context.
- Structured logging redacts JIDs, phone-like values, tokens, seeds, secrets, authorization and related sensitive keys before the sink.
- Boundary validation uses Zod through the shared contract parser.
- Idempotency keys always have an explicit scope and are hashed for storage.
- Mutable aggregate writes use expected revision/version semantics.
- Complex flows declare allowed transitions through the shared state-machine helper.
- Domain events use a versioned envelope with aggregate, timestamp and causality metadata.
- Application/domain code depends on transaction/persistence ports rather than concrete PostgreSQL clients.
- `FeatureAvailability`, `PlayerEligibility`, `FlowState`, and `ActionValidation` remain separate checks. Completing onboarding cannot implicitly enable a globally disabled feature.
- Retrying is allowed only under an explicit `READ_ONLY` or `IDEMPOTENT_MUTATION` policy and a retryable-error classifier.

## Architectural boundary

This phase contains no Pokemon gameplay rule, WhatsApp handler, provider SDK or Gen I-III content. Future modules must import these contracts rather than defining local alternatives.
