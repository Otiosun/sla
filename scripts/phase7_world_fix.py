from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/platform/world/postgres-world-repository.ts",
    '''    return result.rows[0] ?? { encounter_active: false, battle_active: false };''',
    '''    const row = result.rows[0];
    return {
      encounterActive: row?.encounter_active ?? false,
      battleActive: row?.battle_active ?? false,
    };''',
)

replace_once(
    "src/modules/world/service.ts",
    '''      const actionValid =
        destination !== null &&
        destination.active &&
        connection !== null &&
        connection.active &&
        missing.length === 0;''',
    '''      const actionValid = destination?.active === true && connection?.active === true && missing.length === 0;''',
)

print("Phase 7 world mapping fixes applied")
