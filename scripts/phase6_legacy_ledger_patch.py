from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "tests/db/schema.integration.test.ts",
    '''      `INSERT INTO inventory_ledger(\n         id, player_id, item_id, delta, source_type, source_id, actor_type,\n         idempotency_scope, idempotency_key\n       ) VALUES ($1, $2, $3, 5, 'TEST', 'same-source', 'SYSTEM', 'test-grant', $4)\n       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING\n       RETURNING id`,\n      [ledgerId, playerId, itemId, key],''',
    '''      `INSERT INTO inventory_ledger(\n         id, player_id, item_id, delta, source_type, source_id, reason, actor_type,\n         idempotency_scope, idempotency_key, correlation_id\n       ) VALUES (\n         $1, $2, $3, 5, 'TEST', 'same-source', 'schema idempotency regression',\n         'SYSTEM', 'test-grant', $4, $1\n       )\n       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING\n       RETURNING id`,\n      [ledgerId, playerId, itemId, key],''',
)

replace_once(
    "src/modules/economy/service.ts",
    '''    const [walletLedger, inventoryLedger] = await Promise.all([\n      transaction.findWalletLedger(\n        walletMetadata.idempotency.scope,\n        walletMetadata.idempotency.storageKey,\n      ),\n      transaction.findInventoryLedger(\n        inventoryMetadata.idempotency.scope,\n        inventoryMetadata.idempotency.storageKey,\n      ),\n    ]);''',
    '''    const walletLedger = await transaction.findWalletLedger(\n      walletMetadata.idempotency.scope,\n      walletMetadata.idempotency.storageKey,\n    );\n    const inventoryLedger = await transaction.findInventoryLedger(\n      inventoryMetadata.idempotency.scope,\n      inventoryMetadata.idempotency.storageKey,\n    );''',
)

replace_once(
    "src/modules/economy/service.ts",
    '''    const [walletAmount, inventoryQuantity] = await Promise.all([\n      transaction.walletBalance(playerId, offer.currencyId),\n      transaction.inventoryBalance(playerId, offer.itemId),\n    ]);''',
    '''    const walletAmount = await transaction.walletBalance(playerId, offer.currencyId);\n    const inventoryQuantity = await transaction.inventoryBalance(playerId, offer.itemId);''',
)

replace_once(
    "tests/db/economy.integration.test.ts",
    '''    await pool.query("UPDATE content_releases SET status = 'ARCHIVED' WHERE id = $1", [fixture.releaseId]);\n\n    const afterSwitch = unwrap(''',
    '''    const afterSwitch = unwrap(''',
)

replace_once(
    "tests/db/economy.integration.test.ts",
    '''    expect(unwrap(await service.getWalletBalance(playerId, fixture.currencyId))).toBe(300n);\n    expect(unwrap(await service.getInventoryBalance(playerId, fixture.itemId))).toBe(1n);\n  });\n\n  it("rolls back ledger claims and wallet debit if a later purchase step fails", async () => {''',
    '''    expect(unwrap(await service.getWalletBalance(playerId, fixture.currencyId))).toBe(300n);\n    expect(unwrap(await service.getInventoryBalance(playerId, fixture.itemId))).toBe(1n);\n\n    await pool.query(\n      "UPDATE content_release_pointers SET content_release_id = $1 WHERE pointer_key = 'ACTIVE'",\n      [fixture.releaseId],\n    );\n  });\n\n  it("rolls back ledger claims and wallet debit if a later purchase step fails", async () => {''',
)

replace_once(
    "src/modules/catalog/validation.ts",
    '''      priceAmount === null ||\n      priceAmount < 0n ||''',
    '''      priceAmount === null ||\n      priceAmount <= 0n ||''',
)

replace_once(
    "src/modules/catalog/validation.ts",
    '''          "Purchase quantity must be positive, price non-negative, and sort order a non-negative safe integer",''',
    '''          "Purchase quantity and price must be positive, and sort order must be a non-negative safe integer",''',
)

print("Phase 6 validation fixes staged successfully")
