import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { MessagingRepository, OutboundMessageAdapter } from "../../src/modules/messaging/ports.js";
import { OutboxWorker } from "../../src/modules/messaging/service.js";
import { baileysOutboundMessageId } from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import { IncidentalMenuOutboxDeliveryPreparation } from "../../src/platform/exploration/incidental-menu-outbox-delivery-preparation.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../src/shared-kernel/result.js";
import type { IssuedIncidentalMenu } from "../../src/platform/exploration/postgres-incidental-menu-snapshots.js";

const playerId=createPlayerId();
const menuId=randomUUID();
const offeredText="✦ *𝗥𝗢𝗧𝗢𝗠*\n2. ◉ Poké Ball";
const message:PendingOutboxMessage={
  id:randomUUID(),channel:"whatsapp",destinationRef:"120363123456789@g.us",
  messageType:"TEXT",payload:{
    text:offeredText,incidentalMenu:{playerId,menuId},
  },
  idempotencyKey:"expedition.incidental.menu:"+menuId,
  correlationId:randomUUID(),causationId:null,attempts:1,
};
const menu:IssuedIncidentalMenu={
  menuId,outcomeId:randomUUID(),ballItemIds:{POKE:randomUUID()},
  menu:{visible:"",expanded:"",text:offeredText,padded:false,
    choices:[{optionNo:2,kind:"CAPTURE",ball:"POKE"}],
    encounterRevision:2n,encounterId:randomUUID()},
};
function setup(){
  const lookup=vi.fn(async (_playerId:typeof playerId,_menuId:string):
    Promise<Result<IssuedIncidentalMenu>>=>ok(menu));
  const bind=vi.fn(async (_input:unknown):Promise<Result<void>>=>ok(undefined));
  const preparation=new IncidentalMenuOutboxDeliveryPreparation({
    provider:"baileys",
    snapshots:{findForPlayer:lookup},
    binding:{bindDelivered:bind},
    providerMessageIdFor:baileysOutboundMessageId,
  });
  return {preparation,lookup,bind};
}
describe("Incidental menu outbox prebinding (SHADOW ONLY)",()=>{
  it("binds exact server-issued menu, chat and deterministic provider ID BEFORE send",async()=>{
    const {preparation,lookup,bind}=setup();
    await preparation.prepare(message);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(playerId,menuId);
    expect(bind).toHaveBeenCalledExactlyOnceWith({
      playerId,menuId,message:{
        provider:"baileys",chatRef:message.destinationRef,
        externalMessageId:baileysOutboundMessageId(message),
      },
    });
  });

  it("uses unchanged provider message ID after retrying an outbox row",async()=>{
    const {preparation,bind}=setup();
    await preparation.prepare({...message,attempts:1});
    await preparation.prepare({...message,attempts:3});
    expect(bind).toHaveBeenCalledTimes(2);
    expect(bind.mock.calls[0]?.[0]).toEqual(bind.mock.calls[1]?.[0]);
  });

  it("rejects foreign menus, modified text and non-text messages BEFORE provider sends",async()=>{
    const {preparation,lookup,bind}=setup();
    for(const item of [
      {...message,payload:{...message.payload,text:"different"}},
      {...message,payload:{...message.payload,incidentalMenu:{playerId,menuId:"bad"}}},
      {...message,payload:{...message.payload,incidentalMenu:{playerId:"not-a-uuid",menuId}}},
      {...message,messageType:"IMAGE"},
      {...message,payload:{...message.payload,incidentalMenu:"user controlled"}},
    ]) await expect(preparation.prepare(item)).rejects.toThrow();
    expect(bind).not.toHaveBeenCalled();
    lookup.mockResolvedValueOnce(err(appError("FLOW_BLOCKED","Not owned")));
    await expect(preparation.prepare(message)).rejects.toThrow();
    expect(bind).not.toHaveBeenCalled();
  });

  it("returns safely when no incidental anchor or a non-WhatsApp channel is present",async()=>{
    const {preparation,lookup,bind}=setup();
    await preparation.prepare({...message,payload:{text:"ordinary"}});
    await preparation.prepare({...message,channel:"INTERNAL"});
    expect(lookup).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("fails the OutboxWorker delivery before sending if durable bind fails",async()=>{
    const {preparation,bind}=setup();
    bind.mockResolvedValueOnce(err(appError("FLOW_BLOCKED","DB unavailable")));
    const events:string[]=[];
    const repo={
      claimOutbox:async()=>[message],
      markOutboxSent:async()=>{events.push("sent")},
      markOutboxFailed:async()=>{events.push("failed")},
    } as unknown as MessagingRepository;
    const sender:OutboundMessageAdapter={
      channel:"whatsapp",
      send:async()=>{events.push("send");return {
        providerExternalMessageId:baileysOutboundMessageId(message),
      }},
    };
    const worker=new OutboxWorker(repo,[sender],{
      batchSize:5,staleAfterMs:30000,maxAttempts:8,
      baseBackoffMs:1000,maxBackoffMs:60000,
    },preparation);
    expect(await worker.runOnce()).toEqual({claimed:1,sent:0,failed:1});
    expect(events).toEqual(["failed"]);
  });

  it("delivers after binding succeeds using the same OutboxWorker",async()=>{
    const {preparation,bind}=setup();
    const events:string[]=[];
    const repo={
      claimOutbox:async()=>[message],
      markOutboxSent:async()=>{events.push("sent")},
      markOutboxFailed:async()=>{events.push("failed")},
    } as unknown as MessagingRepository;
    const sender:OutboundMessageAdapter={
      channel:"whatsapp",
      send:async()=>{events.push("send");return{
        providerExternalMessageId:baileysOutboundMessageId(message),
      }},
    };
    const worker=new OutboxWorker(repo,[sender],{
      batchSize:5,staleAfterMs:30000,maxAttempts:8,
      baseBackoffMs:1000,maxBackoffMs:60000,
    },preparation);
    expect(await worker.runOnce()).toEqual({claimed:1,sent:1,failed:0});
    expect(bind).toHaveBeenCalledOnce();
    expect(events).toEqual(["send","sent"]);
  });
});
