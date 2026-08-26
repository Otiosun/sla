from pathlib import Path

path = Path("tests/db/schema.integration.test.ts")
text = path.read_text()
old = '''      `INSERT INTO inventory_ledger(\n         id, player_id, item_id, delta, source_type, source_id, actor_type,\n         idempotency_scope, idempotency_key\n       ) VALUES ($1, $2, $3, 5, 'TEST', 'same-source', 'SYSTEM', 'test-grant', $4)\n       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING\n       RETURNING id`,\n      [ledgerId, playerId, itemId, key],'''
new = '''      `INSERT INTO inventory_ledger(\n         id, player_id, item_id, delta, source_type, source_id, reason, actor_type,\n         idempotency_scope, idempotency_key, correlation_id\n       ) VALUES (\n         $1, $2, $3, 5, 'TEST', 'same-source', 'schema idempotency regression',\n         'SYSTEM', 'test-grant', $4, $1\n       )\n       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING\n       RETURNING id`,\n      [ledgerId, playerId, itemId, key],'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one legacy inventory ledger fixture anchor, found {count}")
path.write_text(text.replace(old, new, 1))
print("Phase 6 legacy ledger fixture patched")
