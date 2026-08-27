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
old = '''  const domain = new AdminDomainOperationService(
    economy,
    new PostgresAdminOperationCompletion(pool),
  );'''
new = '''  const domain = new AdminDomainOperationService(
    economy,
    progression,
    new PostgresAdminOperationCompletion(pool),
  );'''
if old not in text:
    raise SystemExit("domain proof constructor anchor missing")
text = text.replace(old, new, 1)
text = text.replace(
    "JOIN admin_operation_changes change ON change.admin_operation_id = $2\n     WHERE progression.player_id = $1`,\n    [playerId, crashTrainer.operation.id],",
    "JOIN admin_operation_changes change ON change.admin_operation_id = $3\n     WHERE progression.player_id = $1`,\n    [playerId, crashTrainer.operation.id, crashTrainer.operation.id],",
    1,
)
proof.write_text(text)
