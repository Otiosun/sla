import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const GEN123_SOURCE = {
  provider: "PokeAPI/pokeapi",
  commit: "7af36d9f3424366ffc46e90d94c8bc120df39cd0",
  license: "BSD-3-Clause",
  sourceSubdirectory: "data/v2/csv",
  speciesMaxNationalDex: 386,
  maxGeneration: 3,
  maxVersionGroupId: 7,
  maxVersionId: 11,
} as const;

export const GEN123_SOURCE_FILES = [
  "pokemon_species.csv",
  "pokemon.csv",
  "pokemon_stats.csv",
  "pokemon_types.csv",
  "pokemon_forms.csv",
  "types.csv",
  "type_efficacy.csv",
  "moves.csv",
  "pokemon_moves.csv",
  "abilities.csv",
  "pokemon_abilities.csv",
  "natures.csv",
  "pokemon_evolution.csv",
  "items.csv",
  "regions.csv",
  "locations.csv",
  "location_areas.csv",
  "encounters.csv",
  "encounter_slots.csv",
] as const;

export type CsvRow = Readonly<Record<string, string>>;

function parseCsvText(text: string): CsvRow[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.length > 0)) records.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  const headers = records.shift();
  if (headers === undefined) return [];
  return records.map((values) => {
    const result: Record<string, string> = {};
    headers.forEach((header, index) => {
      result[header] = values[index] ?? "";
    });
    return result;
  });
}

export class Gen123Source {
  public constructor(private readonly directory: string) {}

  public static fromEnvironment(): Gen123Source {
    const directory = process.env.POKEAPI_DATA_DIR;
    if (directory === undefined || directory.trim().length === 0) {
      throw new Error(
        "POKEAPI_DATA_DIR is required. Point it at the pinned PokeAPI data/v2/csv directory.",
      );
    }
    return new Gen123Source(directory);
  }

  public async csv(file: (typeof GEN123_SOURCE_FILES)[number]): Promise<CsvRow[]> {
    const text = await readFile(join(this.directory, file), "utf8");
    return parseCsvText(text);
  }

  public async assertComplete(): Promise<void> {
    await Promise.all(GEN123_SOURCE_FILES.map((file) => this.csv(file)));
  }
}

export function requiredInt(row: CsvRow, field: string): number {
  const raw = row[field];
  if (raw === undefined || raw === "") throw new Error(`Missing integer field ${field}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer ${field}=${raw}`);
  return value;
}

export function optionalInt(row: CsvRow, field: string): number | null {
  const raw = row[field];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer ${field}=${raw}`);
  return value;
}

export function requiredText(row: CsvRow, field: string): string {
  const value = row[field];
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing text field ${field}`);
  return value.trim();
}

export function sourceMetadata(extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    sourceProvider: GEN123_SOURCE.provider,
    sourceCommit: GEN123_SOURCE.commit,
    sourceLicense: GEN123_SOURCE.license,
    ...extra,
  };
}
