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
export function parseVersionedEvolutionChain(raw:ExternalEvolutionChain):readonly EvolutionSourceEdge[] {
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
      if(!Array.isArray(alternatives)||alternatives.length===0){
        edges.push({
          fromSpeciesSlug:node.species.name,toSpeciesSlug:child.species.name,
          sourceChainId:raw.id,sourceTrigger:"UNSPECIFIED",
          method:"CONDITION_REVIEW",requiredLevel:null,itemSlug:null,
          nontrivialRequirements:["MISSING_SOURCE_DETAILS"],sourceData:{},
        });
      }else{
        for(const detail of alternatives){
          const trigger=detail.trigger?.name??"UNSPECIFIED";
          if(!SLUG.test(trigger) && trigger!=="UNSPECIFIED"){
            throw new Error("Unknown evolution trigger identifier");
          }
          const sourceData=asObject(detail);
          const extras=Object.keys(sourceData).filter(key =>
            !["trigger","item","min_level"].includes(key) && meaningful(sourceData[key])).sort();
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
          edges.push({
            fromSpeciesSlug:node.species.name,toSpeciesSlug:child.species.name,
            sourceChainId:raw.id,sourceTrigger:trigger,
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
