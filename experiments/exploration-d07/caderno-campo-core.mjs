/**
 * Pokémon Beyond — Exploração 2.0, D07 LAB (NÃO instalado).
 * Projeção imutável de observações já confirmadas e publicadas.
 * Sem SQL, RNG, inventário, equipe, concessão de XP ou alteração de state.
 * A camada que alimenta a função DEVE ter comprovado ownership, release,
 * area/período, outcome e confirmação de entrega antes de definir verified.
 */
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const KINDS = new Set(['NO_SIGNAL','TRAIL','DIRECT','INCIDENTAL','CAPTURE_REGISTERED']);
const safe = v => typeof v==='string' && v.length>=2 && v.length<=70 &&
  !/[\r\n*_~`<>\u031d]/u.test(v) && !/\p{Cc}/u.test(v);
const hour = value => value === 'DAY' ? 'dia' : 'noite';
function check(raw, playerId, releaseId){
  if(!raw || !UUID.test(raw.eventId) || raw.playerId!==playerId ||
     raw.contentReleaseId!==releaseId || !UUID.test(raw.expeditionId) ||
     !UUID.test(raw.areaId) || !safe(raw.areaName) ||
     !['DAY','NIGHT'].includes(raw.period) || !KINDS.has(raw.kind) ||
     raw.verified!==true || raw.delivered!==true ||
     !(typeof raw.timestamp==='string' && !Number.isNaN(Date.parse(raw.timestamp)))){
    return false;
  }
  if(raw.kind==='CAPTURE_REGISTERED'){
    return safe(raw.speciesName) && ['PENDING','RELEASED'].includes(raw.economyStatus) && UUID.test(raw.pokemonInstanceId);
  }
  return raw.speciesName===undefined && raw.economyStatus===undefined && raw.pokemonInstanceId===undefined;
}
export function projectFieldNotebook({playerId,contentReleaseId,events,maxEvents=100}={}){
  if(!UUID.test(playerId??'') || !UUID.test(contentReleaseId??'') || !Array.isArray(events) ||
     !Number.isSafeInteger(maxEvents) || maxEvents<1 || maxEvents>500){
    return {ok:false,reason:'INVALID_SCOPE'};
  }
  if(events.length>maxEvents) return {ok:false,reason:'EVENT_LIMIT'};
  const unique=new Map();
  for(const raw of events){
    if(!check(raw,playerId,contentReleaseId)) return {ok:false,reason:'UNVERIFIED_EVIDENCE'};
    const event={...raw};
    const existing=unique.get(raw.eventId);
    if(existing){
      if(JSON.stringify(existing)!==JSON.stringify(event)) return {ok:false,reason:'CONFLICTING_REPLAY'};
      continue;
    }
    unique.set(raw.eventId,event);
  }
  const observations=[...unique.values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.eventId.localeCompare(b.eventId));
  const byPlace=new Map();
  for(const e of observations){
    const key=`${e.areaId}:${e.period}`;
    let group=byPlace.get(key);
    if(!group){group={areaId:e.areaId,areaName:e.areaName,period:e.period,counts:{TRAIL:0,DIRECT:0,INCIDENTAL:0,NO_SIGNAL:0,CAPTURE_REGISTERED:0},captured:[]};byPlace.set(key,group);}
    if(group.areaName!==e.areaName) return {ok:false,reason:'PLACE_LABEL_CONFLICT'};
    group.counts[e.kind]++;
    if(e.kind==='CAPTURE_REGISTERED') group.captured.push({name:e.speciesName,status:e.economyStatus});
  }
  const groups=[...byPlace.values()].sort((a,b)=>a.areaName.localeCompare(b.areaName,'pt-BR')||a.period.localeCompare(b.period));
  const leads=groups.filter(g=>g.counts.TRAIL+g.counts.DIRECT+g.counts.INCIDENTAL>0)
    .map(g=>({areaName:g.areaName,period:g.period,reason:'OBSERVED_TRACE_OR_ENCOUNTER'}));
  return {ok:true,summary:{events:observations.length,places:groups.length},groups,leads};
}
export function renderFieldNotebook(book){
  if(book?.ok!==true) return null;
  const lines=['✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗔𝗗𝗘𝗥𝗡𝗢*','> _Aqui está o que realmente registramos._',''];
  if(book.groups.length===0){lines.push('Ainda não há observações confirmadas.');return lines.join('\n');}
  for(const group of book.groups.slice(0,8)){
    lines.push(`◇ *${group.areaName}* · ${hour(group.period)}`);
    if(group.counts.TRAIL) lines.push(`● Rastros registrados: ${group.counts.TRAIL}`);
    if(group.counts.DIRECT+group.counts.INCIDENTAL) lines.push(`● Encontros registrados: ${group.counts.DIRECT+group.counts.INCIDENTAL}`);
    if(group.counts.NO_SIGNAL) lines.push(`● Buscas sem sinal: ${group.counts.NO_SIGNAL}`);
    for(const p of group.captured.slice(0,4)) lines.push(`● ${p.name}: captura ${p.status==='PENDING'?'pendente':'liberada'}`);
    lines.push('');
  }
  if(book.leads.length){
    lines.push('◇ *𝗣𝗜𝗦𝗧𝗔𝗦 𝗔 𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔𝗥*');
    for(const lead of book.leads.slice(0,3)) lines.push(`● ${lead.areaName} · ${hour(lead.period)}: houve sinais registrados`);
    lines.push('_Observações passadas não garantem novos encontros._');
  }
  return lines.join('\n').trim();
}
