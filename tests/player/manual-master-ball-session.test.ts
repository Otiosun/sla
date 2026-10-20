import { describe,expect,it } from "vitest";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
describe("MASTER pack boundary",()=>{
  it("defaults old payment and checkout routes to NOT_FOUND even with a valid session", async()=>{
    const handler = new PlayerPortalHttpHandler({
      sessions: { verify: () => ({ ok: true, value: { provider: "baileys", externalId: "synthetic@s.whatsapp.net" } }) },
    } as unknown as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);
    const cookie = { cookie: "__Host-pokemon_hub_session=synthetic-only" };
    const checkout = await handler.handle(new Request("https://staging.invalid/v1/hub/player/premium/orders",{
      method:"POST",headers:cookie,body:"{}",
    }));
    const payment = await handler.handle(new Request("https://staging.invalid/v1/hub/admin/premium/orders/22222222-2222-4222-8222-222222222222/approve",{
      method:"POST",headers:cookie,body:"{}",
    }));
    expect(checkout.status).toBe(404);
    expect(payment.status).toBe(404);
  });
  it("cannot operate without a player session",async()=>{
    const handler=new PlayerPortalHttpHandler({} as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);
    const path="https://staging.invalid/v1/hub/admin/premium/delivery/packs/master";
    expect((await handler.handle(new Request(path))).status).toBe(401);
    expect((await handler.handle(new Request(path,{method:"POST",body:"{}"}))).status).toBe(401);
  });
});
