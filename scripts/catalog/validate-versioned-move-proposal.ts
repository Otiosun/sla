import { readFile } from "node:fs/promises";
import {
  auditCatalogSourceProposal,
  type CatalogSourceManifest,
  type CatalogSourceProposal,
} from "../../src/modules/catalog/stage2-source-proposal-audit.js";

const [manifestPath, proposalPath] = process.argv.slice(2);
if (!manifestPath || !proposalPath)
  throw Error("Pass source manifest and generated proposal paths");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CatalogSourceManifest;
const proposal = JSON.parse(await readFile(proposalPath, "utf8")) as CatalogSourceProposal;
const issues = auditCatalogSourceProposal(manifest, proposal);
console.log(
  JSON.stringify({
    event: "stage2.catalog.source.audit",
    manifestForms: manifest.pokemonSlugs.length,
    sourcedForms: proposal.pokemon.length,
    tmMappings: proposal.machines.length,
    problems: issues.length,
    issues: issues.slice(0, 40),
  }),
);
if (issues.length > 0) process.exitCode = 1;
