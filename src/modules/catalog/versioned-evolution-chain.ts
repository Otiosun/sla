/**
 * Offline evolution graph importer. Raw source conditions must never be
 * coerced into an unconditional level evolution.
 */
type Named = { readonly name: string };
export interface ExternalEvolutionDetail {
  readonly trigger: Named | null;
  readonly item?: Named | null;
  readonly min_level?: number | null;
  readonly [condition: string]: unknown;
}
export interface ExternalEvolutionLink {
  readonly species: Named;
  readonly evolves_to: readonly ExternalEvolutionLink[];
  readonly evolution_details: readonly ExternalEvolutionDetail[] | null;
}
export interface ExternalEvolutionChain {
  readonly id: number;
  readonly chain: ExternalEvolutionLink;
}
export type EvolutionSourceEdge = {
  readonly fromSpeciesSlug: string;
  readonly toSpeciesSlug: string;
  readonly sourceChainId: number;
  readonly sourceTrigger: string;
  readonly sourceVersionGroup: string | null;
  readonly method: "LEVEL" | "ITEM" | "CONDITION_REVIEW";
  readonly requiredLevel: number | null;
  readonly itemSlug: string | null;
  readonly nontrivialRequirements: readonly string[];
  readonly sourceData: Readonly<Record<string,unknown>>;
};
const SLUG=/^[a-z0-9][a-z0-9-]*$/u;
function meaningful(value:unknown):boolean {
  return value!==null && value!==undefined && value!==false && value!=="" &&
    !(Array.isArray(value) && value.length===0);
}
function asObject(value:unknown):Record<string,unknown> {
  return typeof value==="object" && value!==null && !Array.isArray(value)
    ? value as Record<string,unknown> : {};
}
/**
 * One edge per explicit alternative in the evolution chain. Strictly preserve
 * source requirements, including friendship, gender, time, move, weather, etc.
 * Gameplay can only enable bare LEVEL and bare use-item transitions; all
 * nontrivial conditions require a verified domain implementation first.
 */
export function parseVersionedEvolutionChain(
  raw: ExternalEvolutionChain,
  options: { readonly maxVersionGroupId?: number } = {},
): readonly EvolutionSourceEdge[] {
  if(!Number.isInteger(raw.id)||raw.id<1)throw new Error("Invalid evolution chain identity");
  const edges:EvolutionSourceEdge[]=[];
  const route=new Set<string>();
  function visit(node:ExternalEvolutionLink):void {
    if(!SLUG.test(node.species?.name??""))throw new Error("Invalid evolution chain species");
    if(route.has(node.species.name))throw new Error("Evolution chain contains a cycle");
    if(!Array.isArray(node.evolves_to))throw new Error("Invalid evolution tree");
    route.add(node.species.name);
    for(const child of node.evolves_to){
      if(!SLUG.test(child.species?.name??""))throw new Error("Invalid evolution target");
      const alternatives=child.evolution_details;
      const before=Array.isArray(alternatives)?alternatives:[];
      // Version-group URL IDs are monotonic game generations in the PokéAPI.
      // Do not import an evolution method introduced after the pinned game.
      // If the source has several historical entries for the same form pair,
      // use the latest applicable entry, preserving regional form branches.
      const matching=before.filter(detail=>{
        const version=asObject(detail.version_group);
        const url=typeof version.url==="string"?version.url:"";
        const parsed=/^https:\/\/pokeapi\.co\/api\/v2\/version-group\/(\d+)\/$/u.exec(url);
        if(options.maxVersionGroupId === undefined)return true;
        // Unknown version is never treated as a safe historical rule.
        return parsed!==null && Number(parsed[1])<=options.maxVersionGroupId;
      });
      const applicable=new Map<string,ExternalEvolutionDetail>();
      for(const detail of matching){
        const required=asObject(detail.required_pokemon_form).name??"";
        const evolved=asObject(detail.evolved_pokemon_form).name??"";
        const region=asObject(detail.region).name??"";
        const key=[required,evolved,region].join(":");
        const previous=applicable.get(key);
        const prevUrl=typeof asObject(previous?.version_group).url==="string"?
          String(asObject(previous?.version_group).url):"";
        const currentUrl=typeof asObject(detail.version_group).url==="string"?
          String(asObject(detail.version_group).url):"";
        const prevId=Number(/\/(\d+)\/$/u.exec(prevUrl)?.[1]??0);
        const currentId=Number(/\/(\d+)\/$/u.exec(currentUrl)?.[1]??0);
        if(previous===undefined||currentId>prevId)applicable.set(key,detail);
      }
      if(!Array.isArray(alternatives)||alternatives.length===0){
        edges.push({
          fromSpeciesSlug:node.species.name,toSpeciesSlug:child.species.name,
          sourceChainId:raw.id,sourceTrigger:"UNSPECIFIED",sourceVersionGroup:null,
          method:"CONDITION_REVIEW",requiredLevel:null,itemSlug:null,
          nontrivialRequirements:["MISSING_SOURCE_DETAILS"],sourceData:{},
        });
      }else{
        for(const detail of applicable.values()){
          const trigger=detail.trigger?.name??"UNSPECIFIED";
          if(!SLUG.test(trigger) && trigger!=="UNSPECIFIED"){
            throw new Error("Unknown evolution trigger identifier");
          }
          const sourceData=asObject(detail);
          const required=asObject(detail.required_pokemon_form).name;
          const evolved=asObject(detail.evolved_pokemon_form).name;
          const extras=Object.keys(sourceData).filter(key =>
            !["trigger","item","min_level","version_group","is_default"].includes(key) &&
            meaningful(sourceData[key]) &&
            !(key==="required_pokemon_form" && required===node.species.name) &&
            !(key==="evolved_pokemon_form" && evolved===child.species.name)).sort();
          const level=detail.min_level??null;
          if(level!==null && (!Number.isInteger(level)||level<1||level>100)){
            throw new Error("Invalid evolution minimum level");
          }
          const item=detail.item?.name??null;
          if(item!==null && !SLUG.test(item))throw new Error("Invalid evolution item slug");
          const bareLevel=trigger==="level-up" && level!==null && level>=2 &&
            item===null && extras.length===0;
          const bareItem=trigger==="use-item" && item!==null &&
            level===null && extras.length===0;
          const version=asObject(detail.version_group).name;
          edges.push({
            fromSpeciesSlug:node.species.name,toSpeciesSlug:child.species.name,
            sourceChainId:raw.id,sourceTrigger:trigger,
            sourceVersionGroup:typeof version==="string"?version:null,
            method:bareLevel?"LEVEL":bareItem?"ITEM":"CONDITION_REVIEW",
            requiredLevel:level,itemSlug:item,
            nontrivialRequirements:bareLevel||bareItem?[]:extras.length>0?extras:["TRIGGER_REVIEW"],
            sourceData,
          });
        }
      }
      visit(child);
    }
    route.delete(node.species.name);
  }
  visit(raw.chain);
  return edges.sort((a,b)=>a.fromSpeciesSlug.localeCompare(b.fromSpeciesSlug) ||
    a.toSpeciesSlug.localeCompare(b.toSpeciesSlug) ||
    a.method.localeCompare(b.method) ||
    (a.requiredLevel??0)-(b.requiredLevel??0) ||
    (a.itemSlug??"").localeCompare(b.itemSlug??""));
}
