# Administrative surface security review

Scope: the administrative application boundary present in this repository at the Phase 16 hardening checkpoint.

## Current exposed surface

There is no general-purpose HTTP/REST admin panel in the current runtime. Administrative mutations enter through the typed application layer and `AdminOperationRegistry`.

Every registered operation declares:

- operation type and READ/MUTATION kind;
- capability key;
- risk tier;
- authorization mode and target scope;
- strict input schema;
- mutation policy such as reason, expected revision, simulation, confirmation and independent approval requirements.

Unknown operations fail closed. A caller cannot submit arbitrary SQL, arbitrary repository method names or arbitrary object patches through the registry.

## Security findings

### Object authorization / BOLA

Authorization is evaluated against the operation target and configured subject/global scope. Existing Admin Proof coverage exercises denied access to operations and audit records outside the caller's capability/scope.

### Mass assignment

Operation input is parsed by the operation's Zod schema before target calculation or application. Extra or malformed fields do not become repository updates implicitly. Domain repositories are not exposed as generic patch endpoints.

### Stale write / concurrency

Sensitive mutations can require `expectedRevision`; concurrent release mutation is covered by the Phase 16 admin race proof. The first valid mutation wins and stale contenders fail instead of silently overwriting state.

### High-risk mutation gates

The registry supports simulation, confirmation and independent approval. Read operations are forbidden from declaring mutation gates; approval requirements are only valid for mutations.

### Idempotency and crash recovery

Admin operations have durable idempotency/fingerprints and owner evidence. The permanent audit reconstruction proof covers the crash window where the domain owner committed before the administrative completion record and demonstrates convergence without duplicating the economic mutation.

### Auditability

Administrative operations preserve actor, reason, correlation ID, request fingerprint and before/after evidence. Append-only audit evidence is protected from runtime UPDATE/DELETE/TRUNCATE by the permanent privilege-separation proof.

## Required rule for a future web panel/API

A future HTTP, web or mobile admin UI MUST delegate to `AdminService`/`AdminOperationRegistry`; it may not call domain repositories or execute SQL directly. Authentication transport, CSRF/session controls and network exposure will require a new security review when such a surface actually exists.

This review does not claim controls for a nonexistent HTTP panel. It closes the security review of the current administrative API/application boundary only.
