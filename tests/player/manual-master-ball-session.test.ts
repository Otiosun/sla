import { describe,expect,it } from "vitest";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
describe("MASTER pack boundary",()=>{
  it("cannot operate without a player session",async()=>{
    const handler=new PlayerPortalHttpHandler({} as ConstructorParameters<typeof PlayerPortalHttpHandler>[0]);
    const path="https://staging.invalid/v1/hub/admin/premium/delivery/packs/master";
    expect((await handler.handle(new Request(path))).status).toBe(401);
    expect((await handler.handle(new Request(path,{method:"POST",body:"{}"}))).status).toBe(401);
  });
});
