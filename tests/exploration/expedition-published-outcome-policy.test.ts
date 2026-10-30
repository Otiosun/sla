import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  PublishedSearchOutcomePolicy,
  choosePublishedSearchOutcome,
} from "../../src/platform/exploration/expedition-published-outcome-policy.js";
import type { ExpeditionSnapshot } from "../../src/modules/exploration/expedition-state.js";

const types = ["NO_SIGNAL","TRAIL","INCIDENTAL","DIRECT"] as const;
const allZero = () => ({
  NO_SIGNAL:0, TRAIL:0, INCIDENTAL:0, DIRECT:0,
});
const expedition:ExpeditionSnapshot={
  expeditionId:randomUUID(),playerId:randomUUID(),
  areaId:randomUUID(),period:"DAY",phase:"PREPARING",
  elapsedMinutes:0,consumedWeekKey:null,endReason:null,revision:0n,
};
const releaseId=randomUUID();
const policyId=randomUUID();
const secret=Buffer.alloc(32,0x45);

function queryFixture(weights:unknown, rowsCount=1) {
  const rows=rowsCount===0?[]:[{
    policy_id:policyId,release_id:releaseId,weights,
  }];
  const query=vi.fn(async (_sql:string, _params?:unknown[])=>({rows}));
  return {client:{query} as unknown as PoolClient,query};
}

describe("published-only expedition search outcome policy (DRAFT, NO default weights)",()=>{
  it("refuses absent or wrong-sum percentages and unapproved extra fields",()=>{
    expect(choosePublishedSearchOutcome(undefined,0).ok).toBe(false);
    expect(choosePublishedSearchOutcome({...allZero()},0).ok).toBe(false);
    expect(choosePublishedSearchOutcome({
      NO_SIGNAL:9000,TRAIL:1000,INCIDENTAL:0,DIRECT:0,FAKE_REWARD:1,
    },0).ok).toBe(false);
    expect(choosePublishedSearchOutcome({
      NO_SIGNAL:8000,TRAIL:2000,INCIDENTAL:0,DIRECT:0,
    },10_000).ok).toBe(false);
  });

  it("selects only configured categories at exact basis-point boundaries",()=>{
    const weights={NO_SIGNAL:6000,TRAIL:2000,INCIDENTAL:1500,DIRECT:500};
    expect(choosePublishedSearchOutcome(weights,0)).toEqual({ok:true,value:{kind:"NO_SIGNAL"}});
    expect(choosePublishedSearchOutcome(weights,5999)).toEqual({ok:true,value:{kind:"NO_SIGNAL"}});
    expect(choosePublishedSearchOutcome(weights,6000)).toEqual({ok:true,value:{kind:"TRAIL"}});
    expect(choosePublishedSearchOutcome(weights,7999)).toEqual({ok:true,value:{kind:"TRAIL"}});
    expect(choosePublishedSearchOutcome(weights,8000)).toEqual({ok:true,value:{kind:"INCIDENTAL"}});
    expect(choosePublishedSearchOutcome(weights,9499)).toEqual({ok:true,value:{kind:"INCIDENTAL"}});
    expect(choosePublishedSearchOutcome(weights,9500)).toEqual({ok:true,value:{kind:"DIRECT"}});
    expect(choosePublishedSearchOutcome(weights,9999)).toEqual({ok:true,value:{kind:"DIRECT"}});
  });

  it("supports every outcome category WITHOUT hardcoded production odds",()=>{
    for(const kind of types) {
      const weights={...allZero(),[kind]:10_000};
      const decision=choosePublishedSearchOutcome(weights,3137);
      expect(decision).toEqual({ok:true,value:{kind}});
    }
  });

  it("rejects a missing published area/period policy without consuming anything",async()=>{
    const fake=queryFixture({},0);
    const result=await new PublishedSearchOutcomePolicy(secret).decide(fake.client,expedition);
    expect(result).toMatchObject({ok:false,error:{code:"FLOW_BLOCKED"}});
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls[0]?.[1]).toEqual([expedition.areaId,"DAY"]);
  });

  it("only reads ACTIVE/PUBLISHED release and the matching area revision",async()=>{
    const fake=queryFixture({...allZero(),DIRECT:10_000});
    const policy=new PublishedSearchOutcomePolicy(secret);
    const a=await policy.decide(fake.client,expedition);
    const b=await policy.decide(fake.client,expedition);
    expect(a).toEqual({ok:true,value:{kind:"DIRECT"}});
    expect(b).toEqual(a);
    const sql=String(fake.query.mock.calls[0]?.[0]);
    expect(sql).toContain("release.status='PUBLISHED'");
    expect(sql).toContain("area.active=TRUE");
    expect(sql).toContain("pointer.pointer_key='ACTIVE'");
    expect(fake.query).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed rows and invalid lifecycle rather than selecting a fallback",async()=>{
    const fake=queryFixture({...allZero(),NO_SIGNAL:10_000});
    const policy=new PublishedSearchOutcomePolicy(secret);
    expect((await policy.decide(fake.client,{
      ...expedition,phase:"ENDED",consumedWeekKey:"2026-10-26",endReason:"VOLUNTARY",
    })).ok).toBe(false);
    const invalid=queryFixture({...allZero(),NO_SIGNAL:8000});
    expect((await policy.decide(invalid.client,expedition)).ok).toBe(false);
    const spoof=queryFixture({...allZero(),NO_SIGNAL:10_000});
    // A row with a non-UUID release/policy is never treated as published.
    const row=await spoof.client.query("ignored");
    if(row.rows[0] !== undefined) row.rows[0].policy_id="not-a-uuid";
    expect((await policy.decide(spoof.client,expedition)).ok).toBe(false);
  });

  it("requires a nontrivial server-owned secret",()=>{
    expect(()=>new PublishedSearchOutcomePolicy(Buffer.alloc(12))).toThrow();
  });
});
