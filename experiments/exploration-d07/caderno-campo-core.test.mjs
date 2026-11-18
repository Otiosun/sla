import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {projectFieldNotebook,renderFieldNotebook} from './caderno-campo-core.mjs';
const P='11111111-1111-4111-8111-111111111111',R='22222222-2222-4222-8222-222222222222',
E='33333333-3333-4333-8333-333333333333',A='44444444-4444-4444-8444-444444444444';
const event=(kind='TRAIL', overrides={})=>({eventId:'55555555-5555-4555-8555-555555555555',
 playerId:P,contentReleaseId:R,expeditionId:E,areaId:A,areaName:'Vila dos Arrozais',
 period:'NIGHT',kind,verified:true,delivered:true,timestamp:'2026-11-18T09:00:00Z',...overrides});
const make=(events)=>projectFieldNotebook({playerId:P,contentReleaseId:R,events});
test('Caderno registra rastro factual sem inventar especie',()=>{const x=make([event()]);assert.equal(x.ok,true);const msg=renderFieldNotebook(x);assert.match(msg,/Rastros registrados: 1/);assert.ok(!msg.includes('Wooper'));});
test('Caderno agrupa area e periodo, nao copia timeline',()=>{const x=make([event(),event('NO_SIGNAL',{eventId:'66666666-6666-4666-8666-666666666666'})]);assert.deepEqual(x.summary,{events:2,places:1});assert.equal(x.groups[0].counts.NO_SIGNAL,1);});
test('Replay idempotente nao aumenta contagem',()=>{const x=make([event(),event()]);assert.equal(x.summary.events,1);});
test('Replay conflitante e bloqueado',()=>{const x=make([event(),event('DIRECT')]);assert.deepEqual(x,{ok:false,reason:'CONFLICTING_REPLAY'});});
test('Outro jogador, release ou mensagem nao entregue bloqueia',()=>{for(const patch of [{playerId:'77777777-7777-4777-8777-777777777777'},{contentReleaseId:E},{delivered:false},{verified:false}])assert.equal(make([event('TRAIL',patch)]).ok,false);});
test('Captura pendente nunca anuncia equipe nem box',()=>{const x=make([event('CAPTURE_REGISTERED',{speciesName:'Wooper',economyStatus:'PENDING',pokemonInstanceId:'88888888-8888-4888-8888-888888888888'})]);assert.equal(x.ok,true);const msg=renderFieldNotebook(x);assert.match(msg,/captura pendente/);assert.ok(!msg.includes('Equipe')&&!msg.includes('Box'));});
test('Especie inventada a partir de rastro e recusada',()=>{assert.equal(make([event('TRAIL',{speciesName:'Wooper'})]).ok,false);});
test('Area nao confiavel ou rotulo divergente falha fechada',()=>{assert.equal(make([event('TRAIL',{areaName:'*RNG secreto*'})]).ok,false);const z=make([event(),event('NO_SIGNAL',{eventId:'66666666-6666-4666-8666-666666666666',areaName:'Outro lugar'})]);assert.equal(z.reason,'PLACE_LABEL_CONFLICT');});
test('Sem observacoes: texto honesto',()=>{const x=make([]);assert.match(renderFieldNotebook(x),/Ainda não há observações confirmadas/);});
test('Limite e entrada invalidos bloqueados',()=>{assert.equal(projectFieldNotebook({playerId:P,contentReleaseId:R,events:[event()],maxEvents:0}).ok,false);assert.equal(projectFieldNotebook({playerId:P,contentReleaseId:R,events:[event(),event()],maxEvents:1}).ok,false);});
