import { describe, expect, it } from "vitest";
import {
  classifyMoveForBattleReview, type ExternalMoveMechanics,
} from "../../src/modules/catalog/move-mechanics-review.js";

const tackle: ExternalMoveMechanics = {
  name:"tackle",power:40,accuracy:100,pp:35,priority:0,
  type:{name:"normal"},damage_class:{name:"physical"},
  target:{name:"selected-pokemon"},effect_chance:null,stat_changes:[],
  meta:{category:{name:"damage"},ailment:{name:"none"},
    min_hits:null,max_hits:null,min_turns:null,max_turns:null,
    drain:0,healing:0,flinch_chance:0,crit_rate:0,stat_chance:0},
};
describe("PokéAPI moves require mechanics review before publication",()=>{
  it("labels simple one-target physical damage as candidate, never auto-approval",()=>{
    expect(classifyMoveForBattleReview(tackle)).toMatchObject({
      slug:"tackle",category:"PHYSICAL",maxPp:35,basicDamageCandidate:true,reviewReasons:[],
    });
  });
  it("detects status moves and secondary burn effects",()=>{
    const status:ExternalMoveMechanics={...tackle,name:"growl",power:null,
      damage_class:{name:"status"},meta:{...tackle.meta,category:{name:"net-good-stats"}}};
    expect(classifyMoveForBattleReview(status).basicDamageCandidate).toBe(false);
    expect(classifyMoveForBattleReview(status).reviewReasons).toContain("STATUS_MOVE_EFFECT");
    const ember:ExternalMoveMechanics={...tackle,name:"ember",effect_chance:10,
      meta:{...tackle.meta,ailment:{name:"burn"}}};
    expect(classifyMoveForBattleReview(ember).reviewReasons).toContain("SECONDARY_EFFECT");
  });
  it("rejects multi-hit and targeting exceptions from the automatic-basic bucket",()=>{
    const special:ExternalMoveMechanics={...tackle,name:"double-slap",
      meta:{...tackle.meta,min_hits:2,max_hits:5},target:{name:"all-opponents"}};
    expect(classifyMoveForBattleReview(special).reviewReasons)
      .toEqual(expect.arrayContaining(["TARGETING_RULES","MULTI_HIT"]));
  });
  it("cannot import an unknown damage class silently",()=>{
    expect(()=>classifyMoveForBattleReview({...tackle,damage_class:{name:"mystery"}}))
      .toThrow(/Invalid source move/);
  });
});
