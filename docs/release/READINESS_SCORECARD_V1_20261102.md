# Pokémon Beyond — Placar fixo de prontidão para atualização e anúncio

**Versão da régua:** `release-gate-v1` · **Data inicial:** 02/11/2026 (America/Maceio) · **Regra:** 100 pontos distribuídos em dez gates estáveis. O percentual mede critérios concluídos **com evidência** dentro desta régua, não esforço, horas, percentual dos arquivos ou prontidão operacional para corte. Os pesos abaixo NÃO podem mudar entre sessões sem abrir nova versão da régua e preservar este histórico. Se ocorrer regressão, os pontos podem diminuir.

## Checklist estável

| Gate | Peso | Concluído | Evidência / critério de aceitação |
|---|---:|---:|---|
| 1. Motor de exploração e captura canônica isolada | 20 | **20** | Stack PR #316 e integração PostgreSQL18: emissão offline, autorização, captura, Outbox idempotente, recuperação de confirmação, concorrência. **Não significa jogador ativo.** |
| 2. UX de combate / retomada PvP de referência | 10 | **10** | PR #317 recuperou blocos idênticos da #255 e regressões; PR #318 incluiu /aceitar e confirmação SQL com 35 PG18. |
| 3. Pokémon: ficha, coleção, boxes, equipe | 10 | **10** | PR #319/#320: identidade contra stale slot/box, paginação, nomes ambíguos, no-op, troca canônica; crossmodule aprovado. |
| 4. Rotas e autorizações de grupo | 10 | **10** | PR #321: políticas /ir ACTIVE+mechanicalReady, `withOperationalWorldPolicy` exige grupo world no runtime; `/equipe` aplica acesso a mutações, não a consultas; /onde leitura. Retorno por parse seguro antes de DB; narrador com bypass explícito somente. Testes de acesso e CI em [#41496290867](https://github.com/Otiosun/sla/actions/runs/41496290867), [#41496290787](https://github.com/Otiosun/sla/actions/runs/41496290787). |
| 5. UX completa V4 de exploração no WhatsApp real | 10 | **0** | Falta Batalhar, Ignorar, hierarquia AÇÕES/CAPTURAR, mídia aprovada/licenciada e dobra real Ler mais; ACTIONABLE segue offline. |
| 6. Integração e UAT do Hub Premium | 10 | **0** | PR #132 é Draft em repositório distinto, sem comprovação ponta-a-ponta com auth e painel. |
| 7. Conteúdo/migrations e candidata instalável | 10 | **0** | Falta varrer catálogo/odds/TRAIL PUBLISHED, migrations/rollback e compilar pacote Windows vinculado a hash de release. |
| 8. Backup externo criptografado com RESTAURAÇÃO | 10 | **0** | Não existe prova auditada de cópia/restauração de banco, mídia, artefatos ignorados e material necessário, em clone isolado. |
| 9. Homologação real Baileys Android/iOS/Web | 5 | **0** | Sem prova de mensagens reais, quoted replies, captura, rede, dobra e recuperação em aparelhos. |
| 10. Cutover local, smoke e anúncio | 5 | **0** | PM2/Windows, arquivos locais e live DB não inspecionados/alterados; requer GO explícito e UAT; não anunciar. |

**Fórmula:** progresso = soma da coluna Concluído / 100 = **50%**. **Restante: 50 pontos.** No máximo 10 pontos por gate. Toda decisão de GO continua binária: qualquer bloqueio em 5–10 mantém **NO-GO**, mesmo com percentual alto.

## Histórico entre sessões (não reescrever os registros)

| Momento | Candidato | Progresso | Diferença | Prova |
|---|---|---:|---:|---|
| 02/11/2026 · baseline antes da #321 | PR #320, `4fe1f478af30955a3639d60df38bb02219b99524` | **40%** | — | 795 testes crossmodule, 211 focados, 35 PG18. A régua ainda não existia antes: baseline retrospectivo DECLARADO, não medição histórica. |
| 02/11/2026 · após política mundial/grupos | PR #321, código `d6e57fcabf9645a351e42300119c32f64a58d205` | **50%** | **+10 pontos percentuais** | [CI focada #41496290867](https://github.com/Otiosun/sla/actions/runs/41496290867) SUCCESS: 225/225 Vitest, 35/35 PG18, TypeScript, Biome 50 arquivos, build; [crossmodule #41496290787](https://github.com/Otiosun/sla/actions/runs/41496290787) SUCCESS: 805 PASS, 1 SKIP; [Narrative #41496290778](https://github.com/Otiosun/sla/actions/runs/41496290778) SUCCESS. |

| 02/11/2026 · continuação V4 de menu offline | PR #321, código `088e2627a1f80afdca78ff8830d4baefc06f4d6e` | **50%** | **0 p.p.** | Renderização V4 publicada/confirmada apenas em menu ACTIONABLE de testes OFFLINE (DIRECT/INCIDENTAL), espécie e nível por wild snapshot/release publicada, Balls fixas 2/3/4, snapshot/Outbox com texto idêntico, sem Batalhar/Ignorar ou dobra não homologada. [Focused #41507657406](https://github.com/Otiosun/sla/actions/runs/41507657406) SUCCESS: 231 Vitest, 35 PG18, TS, Biome52, build; [crossmodule #41507657415](https://github.com/Otiosun/sla/actions/runs/41507657415) SUCCESS: 806 PASS/1 SKIP; [Narrative #41507657379](https://github.com/Otiosun/sla/actions/runs/41507657379) SUCCESS. Gate 5 continua 0/10, RELEASE NO-GO. |

| 02/11/2026 · continuidade V4: escolha IGNORAR isolada e recuperação | PR #321, código `aa7d5eae2bb6184cbc19fbd907523f5c19097b20` | **50%** | **0 p.p.** | Gate de integridade: menu ACTIONABLE e Outbox verificam texto, ações e Balls congeladas, mantendo READ_ONLY legado; opção 0 IGNORAR só para INCIDENTAL com >=10 min, custo de 10 min e EncounterService.flee na MESMA transação/recibo e replay sem nova cobrança; recuperação de Inbox pós-COMMIT com quote SENT exata, sem segunda fuga. Sem PvE BATALHAR integrado, sem UAT Baileys ou Ler mais real. [Focused #41514029455](https://github.com/Otiosun/sla/actions/runs/41514029455) SUCCESS: 237 Vitest, 36 PG18 descartável, TS/Biome56/build; [crossmodule #41514029424](https://github.com/Otiosun/sla/actions/runs/41514029424) SUCCESS: 812 PASS / 1 SKIP; [narrative #41514029379](https://github.com/Otiosun/sla/actions/runs/41514029379) SUCCESS. Sem merge/deploy/PM2/Baileys/live DB. RELEASE NO-GO. |

| 02/11/2026 · continuação V4: BATALHAR canônico offline + recuperação | PR #321, código `53eafcf485272215c006c9d705cce39d9f3d6cbf` | **50%** | **0 p.p.** | Menu ACTIONABLE offline só oferece 1 BATALHAR quando o time congelado no Encounter tem Nature, Ability e movimentos publicados, HP utilizável e sem outro membro aliado; quote PENDING bloqueado e SENT autorizado. Nova operação PostgreSQL `PostgresExpeditionOfflineBattleStart` confirma Inbox/quote/mode/Outbox, revalida time e inicializa Encounter + BattleService na MESMA transação que grava recibo imutável do battleId; repetição com mesma chave não inicia outra batalha; confirmação pós-COMMIT com Inbox redelivery reconstitui a resposta original, com fingerprint e batalha v0. [Focused #41526138125](https://github.com/Otiosun/sla/actions/runs/41526138125) SUCCESS: 246/246 Vitest, 37/37 PG18 descartável, TypeScript, Biome63, build; [crossmodule #41526138172](https://github.com/Otiosun/sla/actions/runs/41526138172) SUCCESS: 821 PASS/1 SKIP; [Narrative #41526137908](https://github.com/Otiosun/sla/actions/runs/41526137908) SUCCESS. Não é WhatsApp real nem release: NO-GO, PR Draft, sem deploy/PM2/Baileys/live DB. |

## Regras para próxima sessão

1. **Sempre** abrir este arquivo primeiro e repetir as dez linhas com valor Concluído e status ✅/🔄/⏳.
2. Cada atualização deve acrescentar nova linha com data, PR, SHA, percentual anterior, novo, delta e links de evidência; não retroeditar linhas passadas.
3. Só creditar marcos com mudanças efetivas comprovadas na **mesma candidata** e CI/integração adequadas, não com plano, preview ou fixture inativa. Uma alteração em teste offline não fecha os gates de WhatsApp e produção.
4. Comparar `percentual atual – percentual no checkpoint anterior`, não usar estimativas de tempo nem declarar porcentagens 100% sem validar Windows/PM2, rollback e UAT.
5. O placar documenta progresso Git. É diferente do GO binário de release: **RELEASE NO-GO** até concluir os gates restantes.

**Fontes:** [PR #321](https://github.com/Otiosun/sla/pull/321) · [issue mestre #264](https://github.com/Otiosun/sla/issues/264) · [manifesto da candidata](RELEASE_CANDIDATE_MANIFEST_UX_20261102.md) · [handoff Komekko](https://docs.google.com/document/d/1DfnnIPbDPw4obRM-PjrvAySYwiKt0B6R60zrNz1l_bw/edit).
