from pathlib import Path

path = Path("src/modules/admin/domain-service.ts")
text = path.read_text()

old_import = '''  AdminInventoryAdjustInput,\n  AdminPokemonArchiveInput,\n  AdminPokemonEffectApplyInput,\n  AdminPokemonEffectRemoveInput,\n  AdminPokemonHpCorrectInput,\n  AdminPokemonRosterMoveInput,\n  AdminPokemonStatusCorrectInput,\n'''
new_import = '''  AdminInventoryAdjustInput,\n  AdminPokemonArchiveInput,\n  AdminPokemonCreateInput,\n  AdminPokemonEffectApplyInput,\n  AdminPokemonEffectRemoveInput,\n  AdminPokemonHpCorrectInput,\n  AdminPokemonProgressionCorrectInput,\n  AdminPokemonRosterMoveInput,\n  AdminPokemonStatusCorrectInput,\n'''
if old_import not in text:
    raise SystemExit("domain-service import anchor not found")
text = text.replace(old_import, new_import, 1)

anchor = '''  public async applyPokemonRosterMove(\n'''
methods = '''  public async applyPokemonCreate(\n    operation: AdminOperationRecord,\n    actorPrincipalId: string,\n    input: AdminPokemonCreateInput,\n  ): Promise<AdminOperationRecord> {\n    assertPlayerTarget(operation, input.playerId);\n    const result = await this.pokemonOwner().createPokemon({\n      ...input,\n      idempotencyKey: operation.id,\n      correlationId: operation.correlationId,\n      metadata: this.pokemonMetadata(operation),\n    });\n    if (!result.ok) throw ownerError(result.error);\n    return this.completePokemonMutation(\n      operation,\n      actorPrincipalId,\n      result.value.pokemonInstanceId,\n      result.value,\n    );\n  }\n\n  public async applyPokemonProgressionCorrection(\n    operation: AdminOperationRecord,\n    actorPrincipalId: string,\n    input: AdminPokemonProgressionCorrectInput,\n  ): Promise<AdminOperationRecord> {\n    assertPlayerTarget(operation, input.playerId);\n    const result = await this.pokemonOwner().correctProgression({\n      ...input,\n      expectedRevision: requiredExpectedRevision(operation),\n      idempotencyKey: operation.id,\n      correlationId: operation.correlationId,\n      metadata: this.pokemonMetadata(operation),\n    });\n    if (!result.ok) throw ownerError(result.error);\n    return this.completePokemonMutation(\n      operation,\n      actorPrincipalId,\n      input.pokemonInstanceId,\n      result.value,\n    );\n  }\n\n'''
if anchor not in text:
    raise SystemExit("domain-service method anchor not found")
text = text.replace(anchor, methods + anchor, 1)
path.write_text(text)
