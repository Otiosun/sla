import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCorrelationId, createPlayerId, type EncounterId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";
import type { CaptureAttemptInput } from "../../src/modules/capture/contracts.js";
import { renderExpeditionV4IncidentalPanel } from "../../src/modules/exploration/expedition-v4-incidental-panel.js";
import { ExpeditionIncidentalCaptureAction } from "../../src/modules/exploration/expedition-incidental-capture-action.js";
import { ExpeditionIncidentalMenuDispatcher } from "../../src/modules/exploration/expedition-incidental-menu-dispatch.js";
import type { IssuedIncidentalMenu } from "../../src/platform/exploration/postgres-incidental-menu-snapshots.js";

function fixture() {
  const playerId=createPlayerId();
  const encounterId=randomUUID() as EncounterId;
  const ballItemId=randomUUID();
  const serverMenuId=randomUUID();
  const view=renderExpeditionV4IncidentalPanel({
    source:"INCIDENTAL",encounterStatus:"ENGAGED",
    encounterId,encounterRevision:5n,speciesName:"Zigzagoon",level:7,
    canBattle:true,balls:[{kind:"POKE",quantity:2,captureAuthorized:true}],
    canIgnore:false,ignoreMinutes:10,combiningCount:0,
  });
  if(!view.ok)throw Error("Invalid fixture");
  const menu:IssuedIncidentalMenu={
    menuId:serverMenuId,outcomeId:randomUUID(),
    menu:view.value,ballItemIds:{POKE:ballItemId},
  };
  const menus={findForPlayer:vi.fn(async (_player:typeof playerId,_menuId:string)=>ok(menu))};
  const authorize={belongsToPlayer:vi.fn(async()=>true)};
  const result={
    captureAttemptId:randomUUID(),encounterId,battleId:null,
    status:"FAILED" as const,probabilityBasisPoints:5000,
    rollBasisPoints:6500,pokemonInstanceId:null,placement:null,
    events:[],replayed:false,
  };
  const capture={attempt:vi.fn(async (_input:CaptureAttemptInput)=>ok(result))};
  const dispatcher=new ExpeditionIncidentalMenuDispatcher(
    menus,new ExpeditionIncidentalCaptureAction(authorize,capture),
  );
  const input={
    playerId,serverMenuId,rawChoice:"2",inboxIdempotencyKey:"inbox:original",
    correlationId:createCorrelationId(),causationId:null,
  };
  return {input,dispatcher,menus,authorize,capture,menu,result,ballItemId};
}

describe("server-referenced incidental message menu",()=>{
  it("hydrates the exact issued Ball mapping rather than reading a user item id",async()=>{
    const f=fixture();
    expect(await f.dispatcher.dispatchCapture(f.input)).toEqual(ok(f.result));
    expect(f.menus.findForPlayer).toHaveBeenCalledWith(f.input.playerId,f.input.serverMenuId);
    expect(f.capture.attempt).toHaveBeenCalledExactlyOnceWith({
      playerId:f.input.playerId,encounterId:f.menu.menu.encounterId,
      expectedEncounterRevision:5n,expectedBattleVersion:null,
      targetWildNo:1,ballItemId:f.ballItemId,idempotencyKey:"inbox:original",
      correlationId:f.input.correlationId,causationId:null,
    });
  });

  it("forwards the same inbox key across retries without regenerating a Ball ID",async()=>{
    const f=fixture();
    await f.dispatcher.dispatchCapture(f.input);
    await f.dispatcher.dispatchCapture(f.input);
    expect(f.capture.attempt).toHaveBeenCalledTimes(2);
    expect(f.capture.attempt.mock.calls[0]?.[0]).toEqual(f.capture.attempt.mock.calls[1]?.[0]);
  });

  it("rejects missing or foreign server menu references before ever touching CaptureService",async()=>{
    const f=fixture();
    f.menus.findForPlayer.mockResolvedValueOnce(
      err(appError("FLOW_BLOCKED","No issued menu for this trainer")),
    );
    expect((await f.dispatcher.dispatchCapture(f.input)).ok).toBe(false);
    expect(f.capture.attempt).not.toHaveBeenCalled();
    const wrongId={...f.input,rawChoice:"4"};
    expect((await f.dispatcher.dispatchCapture(wrongId)).ok).toBe(false);
    expect(f.capture.attempt).not.toHaveBeenCalled();
  });
});
