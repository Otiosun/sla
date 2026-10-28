import { describe, expect, it } from "vitest";
import {
  auditCatalogSourceProposal, type CatalogSourceManifest, type CatalogSourceProposal,
} from "../../src/modules/catalog/stage2-source-proposal-audit.js";
const hash="a".repeat(64);
const manifest:CatalogSourceManifest={
  versionGroup:"scarlet-violet",pokemonSlugs:["pikachu","pidgey"],
  explicitlyApprovedVersionOverrides:{pidgey:"ultra-sun-ultra-moon"},
};
const proposal:CatalogSourceProposal={
  format:"POKEMON_BEYOND_MOVE_PROPOSAL_V1",
  pokemon:[
    {pokemonSlug:"pikachu",versionGroup:"scarlet-violet",rawSha256:hash,moves:[
      {moveSlug:"quick-attack",method:"LEVEL",learnLevel:1},
      {moveSlug:"thunderbolt",method:"MACHINE",learnLevel:null},
    ]},
    {pokemonSlug:"pidgey",versionGroup:"ultra-sun-ultra-moon",rawSha256:hash,moves:[
      {moveSlug:"tackle",method:"LEVEL",learnLevel:1},
    ]},
  ],
  machines:[{moveSlug:"thunderbolt",itemSlug:"tm126",versionGroup:"scarlet-violet",sha256:hash}],
  evolutionChains:[
    {chainId:1,rawSha256:hash,rootSpeciesSlug:"pikachu",edges:[]},
    {chainId:2,rawSha256:hash,rootSpeciesSlug:"pidgey",edges:[]},
  ],
  moveDefinitions:["quick-attack","thunderbolt","tackle"].map((slug)=>({
    slug,category:"PHYSICAL" as const,typeSlug:"normal",
    power:40,accuracy:100,maxPp:30,priority:0,reviewReasons:[],
    basicDamageCandidate:true,rawSha256:hash,
  })),
};
describe("source manifest and generated complete proposal before publication",()=>{
  it("accepts only explicitly pinned versions, valid checksums and compatible machine item",()=>{
    expect(auditCatalogSourceProposal(manifest,proposal)).toEqual([]);
  });
  it("blocks omitted species even if the other source data is valid",()=>{
    const issues=auditCatalogSourceProposal(manifest,{...proposal,pokemon:proposal.pokemon.slice(0,1)});
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"SOURCE_MISSING_FORM",subject:"pidgey"}),
    ]));
  });
  it("rejects implicit cross-generation substitution and absent machine mapping",()=>{
    const wrong:CatalogSourceProposal={
      ...proposal,
      pokemon:[
        proposal.pokemon[0]!,
        {...proposal.pokemon[1]!,versionGroup:"scarlet-violet"},
      ],
      machines:[],
    };
    const issues=auditCatalogSourceProposal(manifest,wrong);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"VERSION_DRIFT",subject:"pidgey"}),
      expect.objectContaining({code:"MACHINE_SOURCE_MISSING",subject:"scarlet-violet:thunderbolt"}),
    ]));
  });
  it("rejects one TM item mapped to two moves in the same game version",()=>{
    const problems=auditCatalogSourceProposal(manifest,{
      ...proposal,
      machines:[...proposal.machines,{
        ...proposal.machines[0]!,moveSlug:"quick-attack",
      }],
    });
    expect(problems.map(p=>p.code)).toContain("MACHINE_ITEM_CONFLICT");
  });
  it("blocks a source proposal that references a move without reviewed battle parameters",()=>{
    const changed={...proposal,moveDefinitions:proposal.moveDefinitions.filter(x=>x.slug!=="thunderbolt")};
    const issues=auditCatalogSourceProposal(manifest,changed);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"MOVE_DEFINITION_MISSING",subject:"thunderbolt"}),
    ]));
  });
  it("blocks an active Pokémon without a sourced evolution family",()=>{
    const problems=auditCatalogSourceProposal(manifest,{
      ...proposal,evolutionChains:proposal.evolutionChains.slice(0,1),
    });
    expect(problems).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"EVOLUTION_FAMILY_MISSING",subject:"pidgey"}),
    ]));
  });
  it("rejects unknown form, invalid levels and source hashes",()=>{
    const problems=auditCatalogSourceProposal(manifest,{
      ...proposal,pokemon:[...proposal.pokemon,{
        pokemonSlug:"mystery",versionGroup:"scarlet-violet",
        rawSha256:"bad",moves:[{moveSlug:"glitch",method:"LEVEL",learnLevel:101}],
      }],
    });
    expect(problems.map(p=>p.code)).toEqual(expect.arrayContaining([
      "UNMANIFESTED_FORM","SOURCE_UNVERIFIED","MOVE_LEVEL_INVALID",
    ]));
  });
});
