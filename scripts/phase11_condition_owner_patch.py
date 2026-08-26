from pathlib import Path

path = Path("db/proofs/phase11_progression_e2e.ts")
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one target, found {count}")
    text = text.replace(old, new, 1)


replace_once(
    'import { ProgressionService } from "../../src/modules/progression/service.js";\n',
    'import { EvolutionConditionService } from "../../src/modules/progression/evolution-condition-service.js";\n'
    'import { ProgressionService } from "../../src/modules/progression/service.js";\n',
    "service import",
)
replace_once(
    'import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";\n',
    'import { PostgresEvolutionConditionRepository } from "../../src/platform/progression/postgres-evolution-condition-repository.js";\n'
    'import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";\n',
    "repository import",
)

replace_once(
    '''    const conditionCorrelationId = randomUUID();
    await pool.query(
      `INSERT INTO pokemon_evolution_condition_flags(
         pokemon_instance_id, condition_key, status, source_type, source_id, correlation_id
       ) VALUES ($1, $2, 'ACTIVE', 'PROOF', $3, $4)`,
      [
        conditionPlayer.pokemonId,
        conditionProof.conditionKey,
        "phase11-condition-proof",
        conditionCorrelationId,
      ],
    );
    const conditionInput = {
      playerId: conditionPlayer.playerId,
      pokemonInstanceId: conditionPlayer.pokemonId,
      idempotencyKey: "phase11-condition-evolution",
      correlationId: conditionCorrelationId,
      trigger: { kind: "CONDITION" as const },
    };''',
    '''    const conditionOwner = new EvolutionConditionService(
      new PostgresEvolutionConditionRepository(pool),
    );
    const conditionSource = {
      sourceType: "PROOF",
      sourceId: "phase11-condition-proof",
    } as const;
    const firstActivationInput = {
      pokemonInstanceId: conditionPlayer.pokemonId,
      conditionKey: conditionProof.conditionKey,
      ...conditionSource,
      correlationId: randomUUID(),
      expectedRevision: null,
    };
    const firstActivation = unwrap(
      "activate server evolution condition",
      await conditionOwner.activate(firstActivationInput),
    );
    if (
      firstActivation.replayed ||
      firstActivation.status !== "ACTIVE" ||
      firstActivation.revision !== 0
    ) {
      throw new Error(`Initial CONDITION activation was invalid: ${JSON.stringify(firstActivation)}`);
    }
    const activationReplay = unwrap(
      "replay server evolution condition activation",
      await conditionOwner.activate(firstActivationInput),
    );
    if (!activationReplay.replayed || activationReplay.revision !== 0) {
      throw new Error(`CONDITION activation retry mutated state: ${JSON.stringify(activationReplay)}`);
    }

    const revoked = unwrap(
      "revoke server evolution condition",
      await conditionOwner.revoke({
        pokemonInstanceId: conditionPlayer.pokemonId,
        conditionKey: conditionProof.conditionKey,
        ...conditionSource,
        correlationId: randomUUID(),
        expectedRevision: firstActivation.revision,
      }),
    );
    if (revoked.replayed || revoked.status !== "REVOKED" || revoked.revision !== 1) {
      throw new Error(`CONDITION revocation was invalid: ${JSON.stringify(revoked)}`);
    }
    const revokedAttempt = await service.evolvePokemon({
      playerId: conditionPlayer.playerId,
      pokemonInstanceId: conditionPlayer.pokemonId,
      idempotencyKey: "phase11-condition-revoked",
      correlationId: randomUUID(),
      trigger: { kind: "CONDITION" },
    });
    expectFailure("revoked server evolution condition", revokedAttempt, "EVOLUTION_NOT_ELIGIBLE");

    const staleReactivation = await conditionOwner.activate({
      pokemonInstanceId: conditionPlayer.pokemonId,
      conditionKey: conditionProof.conditionKey,
      ...conditionSource,
      correlationId: randomUUID(),
      expectedRevision: 0,
    });
    expectFailure(
      "stale CONDITION reactivation",
      staleReactivation,
      "EVOLUTION_CONDITION_STALE_REVISION",
    );

    const conditionCorrelationId = randomUUID();
    const reactivated = unwrap(
      "reactivate server evolution condition",
      await conditionOwner.activate({
        pokemonInstanceId: conditionPlayer.pokemonId,
        conditionKey: conditionProof.conditionKey,
        ...conditionSource,
        correlationId: conditionCorrelationId,
        expectedRevision: revoked.revision,
      }),
    );
    if (reactivated.replayed || reactivated.status !== "ACTIVE" || reactivated.revision !== 2) {
      throw new Error(`CONDITION reactivation was invalid: ${JSON.stringify(reactivated)}`);
    }

    const conditionInput = {
      playerId: conditionPlayer.playerId,
      pokemonInstanceId: conditionPlayer.pokemonId,
      idempotencyKey: "phase11-condition-evolution",
      correlationId: conditionCorrelationId,
      trigger: { kind: "CONDITION" as const },
    };''',
    "condition SQL fixture",
)

replace_once(
    '''      flags: string;
      caught: string;
      seen: string;''',
    '''      flags: string;
      history: string;
      caught: string;
      seen: string;''',
    "condition audit type",
)
replace_once(
    '''              (SELECT count(*)::text FROM pokemon_evolution_condition_flags WHERE pokemon_instance_id = $1 AND condition_key = $3 AND status = 'ACTIVE') AS flags,
              (SELECT caught_count::text FROM player_pokedex_species entry JOIN pokemon_species dex_species ON dex_species.id = entry.species_id WHERE entry.player_id = $2 AND dex_species.slug = 'charmeleon') AS caught,''',
    '''              (SELECT count(*)::text FROM pokemon_evolution_condition_flags WHERE pokemon_instance_id = $1 AND condition_key = $3 AND status = 'ACTIVE') AS flags,
              (SELECT count(*)::text FROM pokemon_history_events WHERE pokemon_instance_id = $1 AND event_type IN ('EVOLUTION_CONDITION_ACTIVATED', 'EVOLUTION_CONDITION_REVOKED')) AS history,
              (SELECT caught_count::text FROM player_pokedex_species entry JOIN pokemon_species dex_species ON dex_species.id = entry.species_id WHERE entry.player_id = $2 AND dex_species.slug = 'charmeleon') AS caught,''',
    "condition audit SQL",
)
replace_once(
    '''      conditionAuditRow.claims !== "1" ||
      conditionAuditRow.flags !== "1" ||
      Number(conditionAuditRow.caught) < 1 ||''',
    '''      conditionAuditRow.claims !== "1" ||
      conditionAuditRow.flags !== "1" ||
      conditionAuditRow.history !== "3" ||
      Number(conditionAuditRow.caught) < 1 ||''',
    "condition audit assertion",
)

path.write_text(text)
