import { describe, expect, it, vi } from "vitest";
import { IncidentalGameGroupAdmission } from "../../src/modules/exploration/expedition-incidental-game-group-admission.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import type { CommunityChatContext } from "../../src/modules/community/contracts.js";
import type { PlayerAccessRecord } from "../../src/modules/registration/player-access-ports.js";

const playerId=createPlayerId();
const chatRef="120363123456789@g.us";
const allowed:CommunityChatContext={
  known:true,groupId:"synthetic-group-id",role:"GAME",
  capabilities:["world","player.basic","pve","pvp"],
};
const active:PlayerAccessRecord={
  playerId,status:"ACTIVE",approvedReviewId:null,revision:3,
};
function setup(){
  const resolveChat=vi.fn(async (_input:unknown):Promise<CommunityChatContext>=>allowed);
  const load=vi.fn(async (_id:typeof playerId):Promise<PlayerAccessRecord>=>active);
  const gate=new IncidentalGameGroupAdmission({resolveChat},{load});
  const input={provider:"baileys",chatRef,playerId};
  return {resolveChat,load,gate,input};
}
describe("Incidental GAME capability and ACTIVE access admission",()=>{
  it("accepts only configured GAME with world+player.basic and ACTIVE trainer",async()=>{
    const f=setup();
    expect(await f.gate.admits(f.input)).toBe(true);
    expect(f.resolveChat).toHaveBeenCalledExactlyOnceWith({
      provider:"baileys",chatRef,
    });
    expect(f.load).toHaveBeenCalledExactlyOnceWith(playerId);
  });
  it("does not resolve arbitrary DM/chat/provider as a GAME group",async()=>{
    const f=setup();
    for(const changed of [
      {...f.input,chatRef:"5579999999999@s.whatsapp.net"},
      {...f.input,provider:"other"},
      {...f.input,chatRef:"not-genuine-group@g.us"},
    ])expect(await f.gate.admits(changed)).toBe(false);
    expect(f.resolveChat).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  });
  it("rejects unknown group, Reception, retired/other roles and missing game permissions",async()=>{
    const f=setup();
    for(const group of [
      {...allowed,known:false},
      {...allowed,role:"RECEPTION" as const},
      {...allowed,role:"PVP" as const},
      {...allowed,capabilities:["player.basic"] as typeof allowed.capabilities},
      {...allowed,capabilities:["world"] as typeof allowed.capabilities},
    ]) {
      f.resolveChat.mockResolvedValueOnce(group);
      expect(await f.gate.admits(f.input)).toBe(false);
    }
    expect(f.load).not.toHaveBeenCalled();
  });
  it("denies PENDING, PROVISIONING, SUSPENDED and mismatched player",async()=>{
    const f=setup();
    for(const status of ["PENDING","PROVISIONING","SUSPENDED"] as const){
      f.load.mockResolvedValueOnce({...active,status});
      expect(await f.gate.admits(f.input)).toBe(false);
    }
    f.load.mockResolvedValueOnce({...active,playerId:createPlayerId()});
    expect(await f.gate.admits(f.input)).toBe(false);
  });
  it("fails closed on either repository error without mutating groups or players",async()=>{
    const f=setup();
    f.resolveChat.mockRejectedValueOnce(new Error("community DB unavailable"));
    expect(await f.gate.admits(f.input)).toBe(false);
    f.load.mockRejectedValueOnce(new Error("player access DB unavailable"));
    expect(await f.gate.admits(f.input)).toBe(false);
  });
});
