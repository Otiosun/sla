import { describe, expect, it } from "vitest";
import {
  parseVersionedEvolutionChain, type ExternalEvolutionChain,
  type ExternalEvolutionDetail, type ExternalEvolutionLink,
} from "../../src/modules/catalog/versioned-evolution-chain.js";
const leaf=(name:string,detail:ExternalEvolutionDetail):ExternalEvolutionLink=>({
  species:{name},evolves_to:[],evolution_details:[detail],
});
describe("evolution family source importer",()=>{
  it("preserves level chains without granting evolution into missing forms",()=>{
    const graph:ExternalEvolutionChain={
      id:1,chain:{species:{name:"bulbasaur"},evolution_details:null,evolves_to:[
        {species:{name:"ivysaur"},evolution_details:[{
          trigger:{name:"level-up"},min_level:16,item:null,
        }],evolves_to:[leaf("venusaur",{trigger:{name:"level-up"},min_level:32,item:null})]},
      ]},
    };
    expect(parseVersionedEvolutionChain(graph).map(e=>({
      from:e.fromSpeciesSlug,to:e.toSpeciesSlug,method:e.method,level:e.requiredLevel,
    }))).toEqual([
      {from:"bulbasaur",to:"ivysaur",method:"LEVEL",level:16},
      {from:"ivysaur",to:"venusaur",method:"LEVEL",level:32},
    ]);
  });
  it("keeps Eevee branches distinct and refuses to reduce friendship to simple level",()=>{
    const graph:ExternalEvolutionChain={
      id:67,chain:{species:{name:"eevee"},evolution_details:null,evolves_to:[
        leaf("vaporeon",{trigger:{name:"use-item"},item:{name:"water-stone"},min_level:null}),
        leaf("umbreon",{trigger:{name:"level-up"},min_level:null,item:null,
          min_happiness:220,time_of_day:"night"}),
        leaf("sylveon",{trigger:{name:"level-up"},min_level:null,min_affection:2,
          known_move_type:{name:"fairy"}}),
      ]},
    };
    const result=parseVersionedEvolutionChain(graph);
    expect(result.find(e=>e.toSpeciesSlug==="vaporeon")).toMatchObject({
      method:"ITEM",itemSlug:"water-stone",nontrivialRequirements:[],
    });
    expect(result.find(e=>e.toSpeciesSlug==="umbreon")).toMatchObject({
      method:"CONDITION_REVIEW",nontrivialRequirements:["min_happiness","time_of_day"],
    });
    expect(result.find(e=>e.toSpeciesSlug==="sylveon")).toMatchObject({
      method:"CONDITION_REVIEW",nontrivialRequirements:["known_move_type","min_affection"],
    });
  });
  it("does not claim a condition with time of day is an automatic level rule",()=>{
    const graph:ExternalEvolutionChain={
      id:2,chain:{species:{name:"rockruff"},evolution_details:null,evolves_to:[
        leaf("lycanroc",{trigger:{name:"level-up"},min_level:25,time_of_day:"day"}),
      ]},
    };
    expect(parseVersionedEvolutionChain(graph)[0]).toMatchObject({
      method:"CONDITION_REVIEW",nontrivialRequirements:["time_of_day"],
    });
  });
  it("does not mistake source version metadata for an evolution condition",()=>{
    const graph:ExternalEvolutionChain={
      id:1,chain:{species:{name:"bulbasaur"},evolution_details:null,evolves_to:[
        leaf("ivysaur",{version_group:{name:"red-blue",url:"https://pokeapi.co/api/v2/version-group/1/"},
          is_default:true,trigger:{name:"level-up"},min_level:16,
          item:null,min_happiness:null,time_of_day:"",
          required_pokemon_form:{name:"bulbasaur"},evolved_pokemon_form:null}),
      ]},
    };
    expect(parseVersionedEvolutionChain(graph,{maxVersionGroupId:18})).toEqual([
      expect.objectContaining({method:"LEVEL",requiredLevel:16,
        sourceVersionGroup:"red-blue",nontrivialRequirements:[]}),
    ]);
  });
  it("blocks future generation evolution paths and keeps USUM location requirements",()=>{
    const group=(id:number,name:string)=>({
      name,url:"https://pokeapi.co/api/v2/version-group/"+id+"/",
    });
    const graph:ExternalEvolutionChain={
      id:67,chain:{species:{name:"eevee"},evolution_details:null,evolves_to:[
        {species:{name:"leafeon"},evolves_to:[],evolution_details:[
          {version_group:group(17,"sun-moon"),trigger:{name:"level-up"},location:{name:"lush-jungle"}},
          {version_group:group(20,"sword-shield"),trigger:{name:"use-item"},item:{name:"leaf-stone"}},
        ]},
        {species:{name:"sylveon"},evolves_to:[],evolution_details:[
          {version_group:group(25,"scarlet-violet"),trigger:{name:"level-up"},min_happiness:160},
        ]},
      ]},
    };
    const edges=parseVersionedEvolutionChain(graph,{maxVersionGroupId:18});
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      toSpeciesSlug:"leafeon",method:"CONDITION_REVIEW",sourceVersionGroup:"sun-moon",
      nontrivialRequirements:["location"],
    });
  });
  it("fails closed on invalid level and source cycle",()=>{
    const bad:ExternalEvolutionChain={
      id:3,chain:{species:{name:"a"},evolution_details:null,evolves_to:[
        leaf("b",{trigger:{name:"level-up"},min_level:101}),
      ]},
    };
    expect(()=>parseVersionedEvolutionChain(bad)).toThrow(/Invalid evolution minimum level/);
    const cyclic:ExternalEvolutionChain={
      id:3,chain:{species:{name:"a"},evolution_details:null,evolves_to:[{
        species:{name:"b"},evolution_details:[{trigger:{name:"level-up"},min_level:16}],
        evolves_to:[leaf("a",{trigger:{name:"level-up"},min_level:24})],
      }]},
    };
    expect(()=>parseVersionedEvolutionChain(cyclic)).toThrow(/cycle/);
  });
});
