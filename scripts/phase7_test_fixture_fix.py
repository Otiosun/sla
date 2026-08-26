from pathlib import Path

path = Path("tests/db/world.integration.test.ts")
text = path.read_text()
old = '''  await client.query(
    `INSERT INTO onboarding_states(player_id, state, completed_at)
     VALUES ($1, 'COMPLETE', now())`,
    [playerId],
  );'''
new = '''  await client.query(
    `INSERT INTO onboarding_states(player_id, state, starter_claim_key, completed_at)
     VALUES ($1, 'COMPLETE', 'phase7-world-test-starter', now())`,
    [playerId],
  );'''
if text.count(old) != 1:
    raise SystemExit(f"expected exactly one onboarding fixture anchor, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
print("Phase 7 world fixture aligned with onboarding starter-claim invariant")
