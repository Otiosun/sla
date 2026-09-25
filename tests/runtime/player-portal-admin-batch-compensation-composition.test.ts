import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimePath = fileURLToPath(
  new URL("../../src/runtime/compose-player-portal-runtime.ts", import.meta.url),
);
const source = readFileSync(runtimePath, "utf8");

describe("Player Portal advanced admin composition", () => {
  it("registers semantic compensation in the live Hub admin registry", () => {
    expect(source).toContain("new AdminCompensationService(");
    expect(source).toContain("new PostgresAdminCompensationCompletion(options.pool)");
    expect(source).toContain("registerPhase12CompensationOperation(adminRegistry, compensation)");
  });

  it("registers low-risk batch preview/execute without opening high-risk batch", () => {
    expect(source).toContain("new AdminBatchService(");
    expect(source).toContain("new PostgresAdminBatchRepository(options.pool)");
    expect(source).toContain("registerPhase12DBatchAdminOperations(adminRegistry, batch)");
    expect(source).not.toContain('"batch.execute.high_risk"');
  });

  it("shares the same economy/progression owners and composes the full Pokemon admin owner", () => {
    expect(source).toContain(
      "const economy = new EconomyService(new PostgresEconomyRepository(options.pool))",
    );
    expect(source).toContain("const progression = new ProgressionService(");
    expect(source).toContain("const pokemonAdmin = new PokemonAdminService(");
    expect(source).toContain("new PostgresPokemonAdminRepository(options.pool)");
    expect(source).toContain("new PostgresPokemonEffectAdminRepository(options.pool)");
    expect(source).toContain("new PostgresPokemonLifecycleAdminRepository(options.pool)");
    expect(source).toMatch(
      /new AdminDomainOperationService\(\s*economy,\s*progression,\s*adminCompletion,\s*pokemonAdmin,\s*\)/,
    );
    expect(source).toMatch(
      /new AdminCompensationService\(\s*adminRepository,\s*economy,\s*progression,/,
    );
  });
});
