/** Pure source-integrity gate for the offline PokéAPI proposal builder. */
export interface CatalogSourceManifest {
  readonly versionGroup: string;
  readonly pokemonSlugs: readonly string[];
  readonly explicitlyApprovedVersionOverrides?: Readonly<Record<string, string>>;
}
export interface CatalogSourceProposal {
  readonly format: string;
  readonly pokemon: readonly {
    readonly pokemonSlug: string;
    readonly versionGroup: string;
    readonly rawSha256: string;
    readonly moves: readonly {
      readonly moveSlug: string;
      readonly method: "LEVEL"|"EVOLUTION"|"MACHINE"|"TUTOR"|"EGG";
      readonly learnLevel: number|null;
    }[];
  }[];
  readonly machines: readonly {
    readonly itemSlug: string;
    readonly moveSlug: string;
    readonly versionGroup: string;
    readonly sha256: string;
  }[];
  readonly moveDefinitions: readonly {
    readonly slug: string;
    readonly category: "PHYSICAL" | "SPECIAL" | "STATUS";
    readonly typeSlug: string;
    readonly power: number | null;
    readonly accuracy: number | null;
    readonly maxPp: number | null;
    readonly priority: number;
    readonly reviewReasons: readonly string[];
    readonly basicDamageCandidate: boolean;
    readonly rawSha256: string;
  }[];
}
export interface SourceProblem {
  readonly code: string;
  readonly subject: string;
  readonly detail: string;
}
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;
const SHA = /^[0-9a-f]{64}$/u;
const METHODS = new Set(["LEVEL","EVOLUTION","MACHINE","TUTOR","EGG"]);
export function auditCatalogSourceProposal(
  manifest: CatalogSourceManifest,
  proposal: CatalogSourceProposal,
): readonly SourceProblem[] {
  const issues: SourceProblem[] = [];
  const add = (code:string,subject:string,detail:string) => issues.push({code,subject,detail});
  if(proposal.format!=="POKEMON_BEYOND_MOVE_PROPOSAL_V1") {
    add("UNKNOWN_FORMAT","proposal","The source format is not the supported version");
    return issues;
  }
  if(!SLUG.test(manifest.versionGroup) || manifest.pokemonSlugs.length===0) {
    add("INVALID_MANIFEST","manifest","A pinned version group and form list are mandatory");
  }
  const required=new Set(manifest.pokemonSlugs);
  if(required.size!==manifest.pokemonSlugs.length) {
    add("DUPLICATE_MANIFEST_FORM","manifest","One form must be listed only once");
  }
  const overrides=manifest.explicitlyApprovedVersionOverrides??{};
  for(const [slug,version] of Object.entries(overrides)){
    if(!required.has(slug) || !SLUG.test(version))add("INVALID_OVERRIDE",slug,"Version override not approved");
  }
  const found=new Set<string>();
  const machineNames=new Map<string,string>();
  const expectedMachines=new Set<string>();
  for(const form of proposal.pokemon){
    if(found.has(form.pokemonSlug))add("DUPLICATE_FORM",form.pokemonSlug,"Source repeats a form");
    found.add(form.pokemonSlug);
    if(!required.has(form.pokemonSlug))add("UNMANIFESTED_FORM",form.pokemonSlug,"Source form is not approved");
    const version=overrides[form.pokemonSlug]??manifest.versionGroup;
    if(form.versionGroup!==version)add("VERSION_DRIFT",form.pokemonSlug,"Source version does not match manifest");
    if(!SHA.test(form.rawSha256))add("SOURCE_UNVERIFIED",form.pokemonSlug,"Source response has no SHA256 checksum");
    if(form.moves.length===0)add("EMPTY_LEARNSET",form.pokemonSlug,"No source moves available");
    if(!form.moves.some(m=>m.method==="LEVEL" && m.learnLevel!==null && m.learnLevel>=1)){
      add("NO_LEVEL_MOVES",form.pokemonSlug,"No basic progression moves available");
    }
    const unique=new Set<string>();
    for(const move of form.moves){
      if(!SLUG.test(move.moveSlug) || !METHODS.has(move.method)){
        add("INVALID_MOVE",form.pokemonSlug,"Unrecognized move or method");
        continue;
      }
      if(move.method==="LEVEL" ? !Number.isInteger(move.learnLevel) || move.learnLevel===null ||
        move.learnLevel<1 || move.learnLevel>100 : move.learnLevel!==null){
        add("MOVE_LEVEL_INVALID",form.pokemonSlug,move.moveSlug+" has invalid level for "+move.method);
      }
      const key=[move.method,move.moveSlug,move.learnLevel??""].join(":");
      if(unique.has(key))add("MOVE_DUPLICATED",form.pokemonSlug,key);
      unique.add(key);
      if(move.method==="MACHINE")expectedMachines.add([form.versionGroup,move.moveSlug].join(":"));
    }
  }
  for(const slug of required)if(!found.has(slug)){
    add("SOURCE_MISSING_FORM",slug,"Approved species was not downloaded");
  }
  for(const machine of proposal.machines){
    if(!SLUG.test(machine.itemSlug) || !SLUG.test(machine.moveSlug) ||
       !SHA.test(machine.sha256)){
      add("MACHINE_INVALID",machine.itemSlug,"Machine has invalid source identity/checksum");
      continue;
    }
    const sourceKey=[machine.versionGroup,machine.moveSlug].join(":");
    if(!expectedMachines.has(sourceKey)){
      add("MACHINE_WITHOUT_COMPATIBILITY",machine.itemSlug,sourceKey);
    }
    const itemKey=[machine.versionGroup,machine.itemSlug].join(":");
    const prior=machineNames.get(itemKey);
    if(prior!==undefined && prior!==machine.moveSlug){
      add("MACHINE_ITEM_CONFLICT",machine.itemSlug,
        "The same TM item teaches two moves within one game version");
    }
    machineNames.set(itemKey,machine.moveSlug);
  }
  const expectedDefinitions=new Set(proposal.pokemon.flatMap(p=>p.moves.map(m=>m.moveSlug)));
  const defined=new Set<string>();
  for(const definition of proposal.moveDefinitions) {
    if(defined.has(definition.slug)) {
      add("MOVE_DEFINITION_DUPLICATE",definition.slug,"Same move defined more than once");
    }
    defined.add(definition.slug);
    if(!expectedDefinitions.has(definition.slug)) {
      add("MOVE_DEFINITION_UNREFERENCED",definition.slug,"Not present in source learnsets");
    }
    if(!SHA.test(definition.rawSha256) ||
       !SLUG.test(definition.slug) || !SLUG.test(definition.typeSlug) ||
       !Number.isInteger(definition.priority) ||
       !["PHYSICAL","SPECIAL","STATUS"].includes(definition.category) ||
       !Array.isArray(definition.reviewReasons) ||
       definition.reviewReasons.some(reason=>typeof reason!=="string") ||
       definition.basicDamageCandidate !== (definition.reviewReasons.length===0)) {
      add("MOVE_DEFINITION_INVALID",definition.slug,"Corrupted or unreviewable source metadata");
    }
  }
  for(const name of expectedDefinitions) {
    if(!defined.has(name))add("MOVE_DEFINITION_MISSING",name,"Move parameters have no verified source");
  }
  const obtained=new Set(proposal.machines.map(m=>[m.versionGroup,m.moveSlug].join(":")));
  for(const key of expectedMachines)if(!obtained.has(key)){
    add("MACHINE_SOURCE_MISSING",key,"Form has machine compatibility but no verified item");
  }
  return issues;
}
