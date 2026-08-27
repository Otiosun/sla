from pathlib import Path
import runpy

patch = Path("scripts/phase12c_progression_patch.py")
text = patch.read_text()
text = text.replace(
    "Phase 12C domain admin proof complete:",
    "Phase 12C economy admin proof complete:",
)
text = text.replace(
    'const underflow = await admin.prepareMutation({\n    principalId,\n    operationType: "progression.trainer.adjust",',
    'const trainerUnderflow = await admin.prepareMutation({\n    principalId,\n    operationType: "progression.trainer.adjust",',
)
text = text.replace(
    "admin.apply(underflow.operation.id, principalId)",
    "admin.apply(trainerUnderflow.operation.id, principalId)",
)
text = text.replace(
    "[underflow.operation.id],",
    "[trainerUnderflow.operation.id],",
)
patch.write_text(text)
runpy.run_path(str(patch), run_name="__main__")

proof = Path("db/proofs/phase12_domain_admin_e2e.ts")
text = proof.read_text()

catalog_import = 'import { RulesetConfigSchema } from "../../src/modules/catalog/contracts.js";\n'
if catalog_import not in text:
    anchor = 'import { EconomyService } from "../../src/modules/economy/service.js";\n'
    if anchor not in text:
        raise SystemExit("catalog import anchor missing")
    text = text.replace(anchor, catalog_import + anchor, 1)

old = '''  const domain = new AdminDomainOperationService(
    economy,
    new PostgresAdminOperationCompletion(pool),
  );'''
new = '''  const domain = new AdminDomainOperationService(
    economy,
    progression,
    new PostgresAdminOperationCompletion(pool),
  );'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("domain proof constructor anchor missing")

text = text.replace(
    "JOIN admin_operation_changes change ON change.admin_operation_id = $2\n     WHERE progression.player_id = $1`,\n    [playerId, crashTrainer.operation.id],",
    "JOIN admin_operation_changes change ON change.admin_operation_id = $3\n     WHERE progression.player_id = $1`,\n    [playerId, crashTrainer.operation.id, crashTrainer.operation.id],",
    1,
)

fixture_marker = "phase12c-trainer-rules-"
if fixture_marker not in text:
    anchor = "try {\n"
    fixture = '''try {
  const trainerRulesetId = randomUUID();
  const trainerReleaseId = randomUUID();
  const trainerRulesConfig = RulesetConfigSchema.parse({
    schemaVersion: 1,
    battle: {
      statModel: "SIX_STATS",
      physicalSpecialByMove: true,
      ivEnabled: true,
      evEnabled: true,
      natureEnabled: true,
      maxMoves: 4,
      ppEnabled: true,
      criticalMultiplierBasisPoints: 15_000,
      accuracyEvasionEnabled: true,
    },
    capture: {
      model: "POKEMON_INSPIRED_V1",
      maxProbabilityBasisPoints: 10_000,
    },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
    progression: {
      pokemon: {
        xpCurve: "CUBIC_DELTA_V1",
        battleRewardModel: "BASE_EXP_LEVEL_DIV_7_V1",
        rewardRecipient: "ACTIVE_WINNER_V1",
        levelCap: 100,
        hpOnLevelUp: "ADD_MAX_HP_DELTA_IF_ALIVE_V1",
        fullMoveSlotsPolicy: "PENDING_CHOICE_V1",
        autoLevelEvolution: true,
      },
      trainer: {
        visiblePointsName: "Insígnia",
        levelCurve: "LINEAR_100_V1",
        levelCap: 100,
        pointsPerWonBattle: 100,
        unlocks: [{ level: 10, unlockKey: "tournament.eligible" }],
      },
    },
  });
  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [trainerRulesetId, `phase12c-trainer-rules-${trainerRulesetId}`, JSON.stringify(trainerRulesConfig)],
  );
  await pool.query(
    `UPDATE rulesets
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{"proof":true}'::jsonb,
         config_fingerprint = repeat('c', 64)
     WHERE id = $1`,
    [trainerRulesetId],
  );
  await pool.query(
    `UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [trainerRulesetId],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 900002, 'Phase 12C trainer proof', 'DRAFT', $2)`,
    [trainerReleaseId, trainerRulesetId],
  );
  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{"proof":true}'::jsonb,
         content_fingerprint = repeat('d', 64)
     WHERE id = $1`,
    [trainerReleaseId],
  );
  await pool.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [trainerReleaseId],
  );
  await pool.query(
    `INSERT INTO content_release_pointers(pointer_key, content_release_id)
     VALUES ('ACTIVE', $1)
     ON CONFLICT (pointer_key) DO UPDATE
     SET content_release_id = EXCLUDED.content_release_id,
         revision = content_release_pointers.revision + 1,
         updated_at = now()`,
    [trainerReleaseId],
  );
'''
    if anchor not in text:
        raise SystemExit("proof fixture anchor missing")
    text = text.replace(anchor, fixture, 1)

proof.write_text(text)
