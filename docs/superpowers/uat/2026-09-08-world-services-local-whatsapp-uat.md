# World Services V1 — Local WhatsApp UAT

## Purpose

Close the playable WhatsApp acceptance gate for Poké Mart, Pokémon Center, PC/boxes and Fishing without merging PR #158 or touching PR #157.

This runbook complements automated tests. A visually correct message is not enough: each mechanical mutation must be confirmed against canonical PostgreSQL state and restart/reply-binding behavior.

## Hard gates

- Worktree/checkout must be on `feat/world-services-v1`.
- Record the exact `git rev-parse HEAD` before starting.
- Do not use `main` and do not merge PR #158.
- Use the existing local PostgreSQL demo database and existing WhatsApp demo session.
- Exactly one Baileys runtime may own the WhatsApp session.
- Apply all migrations through the current branch before runtime start.
- Player under test must be ACTIVE and mechanically ready in a group with `world` capability.
- Keep a second player available for isolation checks.
- Capture evidence: WhatsApp screenshots/video, relevant DB before/after rows and runtime head SHA.

## Runtime configuration

Use the existing local WhatsApp env file. In addition to its current database/WhatsApp settings, World Services requires the Encounter RNG key for Fishing.

When final Poké Mart artwork is available, configure all three values together:

```env
POKEMART_ENTRY_AREA_ID=<Vila dos Arrozais area UUID>
POKEMART_ENTRY_FACADE_IMAGE_URL=<public HTTPS facade asset>
POKEMART_ENTRY_MERCHANT_IMAGE_URL=<public HTTPS merchant asset>
```

The facade and merchant assets should be versioned under `assets/world-services/` and may be served from the public repository via `raw.githubusercontent.com` for local UAT.

Do not commit secrets or a local `.env` file.

## Preflight evidence

1. Record branch and SHA.
2. Confirm current migrations, including World Services migrations `0035` through `0041`.
3. Confirm the player is in Vila dos Arrozais and ACTIVE.
4. Confirm the local active content release contains:
   - Poké Mart service availability;
   - Pokémon Center service availability;
   - Fishing point configuration for the test fishing area;
   - COMMON and UNCOMMON fishing encounter tables;
   - RARE/EXTREMELY_RARE pools only if explicitly configured by administration;
   - any local-only sale offer used for `/vender` clearly marked as UAT data, never canonical pricing.
5. Start one runtime only.

Recommended runtime command from the existing checkout:

```powershell
node --env-file=.env.whatsapp.demo --import tsx src/main.ts
```

## UAT A — Scene proof and facility admission

### A1. Insufficient scene

Send a normal scene with fewer than four non-empty lines, then `/pokemart`.

Expected:
- no valid facility admission from that scene;
- no consumed valid scene proof;
- no session opened from invalid proof.

### A2. Valid scene

Send one normal narrative message containing at least four non-empty lines, then `/pokemart`.

Expected:
- one proof is consumed once;
- one POKEMART session opens for the player and current area;
- later Mart subcommands do not demand four new lines.

### A3. Media order

With artwork configured, `/pokemart` must produce, in order:

1. facade image + Vila/Poké Mart location caption;
2. merchant image + merchant/attendance caption.

Expected:
- the active reply anchor belongs to the merchant message, not the facade image;
- the two images are not duplicated on retry/restart.

## UAT B — Poké Mart buying

### B1. Catalog and exact reply

Run `/comprar`.

Expected:
- approved catalog appears;
- balance remains visible before any WhatsApp `Ler mais` fold;
- replying `03` to the exact catalog message selects Potion;
- sending `03` without replying to that message does nothing;
- replying `03` to an old/stale catalog message does nothing.

### B2. Quantity purchase

Reply `Potion / 5` to the exact quantity prompt.

Before and after, inspect wallet and inventory.

Expected:
- one atomic purchase;
- five Potion units added exactly once;
- wallet debited by `5 × configured unit price` exactly once;
- receipt reports total, remaining balance and inventory transition;
- retry/replay cannot duplicate item or debit.

### B3. Insufficient funds

Use a quantity whose total exceeds the wallet.

Expected:
- `DINHEIRO INSUFICIENTE` UX;
- current balance, required amount and missing amount are correct;
- no partial debit;
- no inventory credit.

### B4. `/itens`

Run `/itens` inside the active Mart visit.

Expected:
- read-only catalog view;
- no purchase mutation and no accidental quantity action without the proper prompt.

## UAT C — Poké Mart selling

Use an explicitly configured UAT sale offer because final production resale prices were not supplied by the client.

Run `/vender`.

Expected:
- only items the player actually owns AND that have an active sale offer are shown;
- selection is bound to the exact active prompt;
- quantity sale consumes inventory and credits wallet in one transaction;
- insufficient inventory produces the user-facing unavailable response with no partial wallet credit;
- replay never sells or pays twice.

Do not convert the temporary UAT sale price into canonical content.

## UAT D — Pokémon Center

A new facility entry requires its own valid four-line arrival proof because the Mart proof was consumed.

Run `/centropokemon` after a valid scene.

Expected:
- Center/Hana entry UX;
- `/conversar` opens the people prompt;
- exact reply `01` opens Hana dialogue;
- exact reply `02` opens employee guidance;
- stale/human/unrelated replies remain silent.

## UAT E — Real healing

Prepare at least one TEAM Pokémon with:
- HP below max;
- one move with PP below max;
- one healable major status.

Keep a BOX Pokémon damaged/statused as a control.

Run `/curar`.

Expected after commit:
- TEAM HP restored to calculated max;
- TEAM move PP restored to max;
- healable TEAM major status removed;
- BOX control Pokémon unchanged;
- success animation appears only after successful DB commit;
- repeated processing of the same Inbox message is idempotent;
- healing is refused during an incompatible active battle/encounter.

## UAT F — PC storage

Run `/pc`.

Expected:
- real team occupancy;
- real box occupancy;
- `/caixas`, `/depositar`, `/retirar`, `/organizar`, `/sair` available.

### F1. Boxes

Run `/caixas`.

Expected:
- stored Pokémon and levels match DB;
- capacity is 30 slots per box.

### F2. Deposit

Run `/depositar`.

Expected:
- current team is listed;
- exact reply selects one Pokémon;
- selection opens confirmation without mutating yet;
- confirm moves the selected Pokémon TEAM → first free BOX slot transactionally;
- cancel performs no mutation;
- last remaining team member cannot be deposited.

### F3. Withdraw

Run `/retirar`.

Expected:
- stored Pokémon are listed;
- selection opens confirmation without mutating yet;
- confirm moves BOX → first free TEAM slot;
- a full six-Pokémon team blocks withdrawal;
- cancel performs no mutation.

### F4. Organize

Run `/organizar`.

Expected:
- choose a stored Pokémon via exact prompt;
- choose destination Box/slot through the guided prompt;
- occupied destination is rejected without overwriting anything;
- valid destination moves exactly one roster row;
- destination slots are limited to 1–30.

### F5. Internal exit

While the active prompt is a PC prompt, run `/sair`.

Expected:
- returns to Pokémon Center reception;
- Center visit remains open.

Run `/sair` again from the Center context.

Expected:
- facility visit closes and player returns to normal Vila dos Arrozais scene.

## UAT G — Automatic roster placement regression

With TEAM already 6/6 and Box 1 exactly 30/30, create one new canonical roster placement through the existing starter/capture pathway used by the demo.

Expected:
- no `Box 1 / slot 31`;
- next placement is `Box 2 / slot 1`;
- database constraint also rejects any direct BOX slot greater than 30.

## UAT H — Fishing

Move the player to an area with Fishing configured and no incompatible active encounter/battle.

Run `/pescar`.

Expected:
- every successfully reserved fishing action consumes one of the five daily attempts, including D20 1–9 with no encounter;
- displayed D20 tier follows exactly:
  - 1–9: no encounter;
  - 10–14: COMMON;
  - 15–17: UNCOMMON;
  - 18–19: RARE;
  - 20: EXTREMELY RARE;
- encounter results are canonical Encounter records, not direct Pokémon spawns;
- sixth valid attempt is refused;
- retry of the same Inbox message does not consume another attempt;
- active encounter/battle refusal does not consume quota.

RARE and EXTREMELY_RARE species must come only from ADM-configured pools. Never invent a fallback species.

If an ADM rarity pool is absent, treat that as configuration debt/evidence rather than silently inventing content.

## UAT I — Restart persistence

During an active Mart or PC prompt:

1. record the exact provider message being awaited;
2. stop the sole runtime cleanly;
3. restart the same runtime/session without resetting DB/player;
4. reply to the pre-restart active prompt.

Expected:
- service session survives restart;
- exact prompt binding survives restart;
- valid reply continues the flow;
- stale prompt remains silent.

## UAT J — Multi-player isolation

Use Player A and Player B in the same eligible group.

Expected:
- A cannot satisfy B's active prompt;
- A's facility session does not change B's session;
- A's PC/economy/fishing mutations never target B;
- simultaneous use does not cross reply anchors.

## Closing evidence

The UAT gate is GREEN only when all applicable sections above have evidence and:

- final tested `git rev-parse HEAD` is recorded;
- automated GitHub workflow matrix for that exact head is green;
- local runtime started from that same branch/SHA;
- no reset or hidden manual DB correction was needed to make the happy path pass;
- any deliberate local-only content (sale prices, optional rarity pools) is identified and excluded from canonical product decisions;
- PR #158 remains unmerged until explicit authorization.
