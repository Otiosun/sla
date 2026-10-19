import {describe,expect,it,vi} from "vitest";
import {PlayerPortalHttpHandler} from "../../src/modules/player-portal/http-handler.js";
import {ok} from "../../src/shared-kernel/result.js";
const owner="33333333-3333-4333-8333-333333333333";
const itemId="22222222-2222-4222-8222-222222222222";
function make(stage=true,published=true) {
  const apply=vi.fn(async()=>({id:owner,status:"APPLIED"}));
  const prepare=vi.fn(async()=>({operation:{id:owner,status:"READY"},replayed:false}));
  const instance=new PlayerPortalHttpHandler({
    sessions:{verify:()=>ok({provider:"baileys",externalId:"test@s.whatsapp.net"})},
    admin:{resolvePrincipal:async()=>({principalId:owner}),capabilitiesFor:async()=>["central.view"]},
    adminTeam:{isOwner:async()=>true},
    adminRewardCatalog:{get:async()=>({items:published?[{itemId,slug:"master-ball",displayName:"Master Ball"}]:[]})},
    adminMutations:{prepareMutation:prepare,apply},
    ...(stage?{premiumDelivery:{}}:{}),
  } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);
  const call=(method:"GET"|"POST",body?:unknown)=>instance.handle(new Request(
    "https://staging.invalid/v1/hub/admin/premium/delivery/packs/master",{
      method,headers:{cookie:"__Host-pokemon_hub_session=test-token"},
      ...(body?{body:JSON.stringify(body)}:{}),
    }));
  return {call,prepare,apply};
}
describe("MASTER pack published catalogue",()=>{
  it("never fabricates an unpublished ball or bypasses staging",async()=>{
    const x=make(true,false);
    expect(await (await x.call("GET")).json()).toMatchObject({available:false,item:null});
    const y=make(false,true);
    expect((await y.call("GET")).status).toBe(503);
  });
  it("uses the exact authoritative ball and strict request identity",async()=>{
    const x=make();
    const data={requestId:"44444444-4444-4444-8444-444444444444",
      playerId:"11111111-1111-4111-8111-111111111111",
      sku:"MASTER",quantity:2,reason:"Entrega manual de Master Balls verificada."};
    expect((await x.call("POST",{...data,paid:true})).status).toBe(400);
    expect((await x.call("POST",data)).status).toBe(201);
    expect(x.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationType:"inventory.adjust",input:{playerId:data.playerId,itemId,delta:"2"},
      idempotencyKey:"premium-pack:MASTER:"+data.requestId,
    }));
    expect(x.apply).toHaveBeenCalledTimes(1);
  });
});
