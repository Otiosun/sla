# Pokémon Beyond — ordem canônica: desenvolvimento completo ANTES da instalação local

**Decisão do proprietário — 02/11/2026.** Este documento esclarece a ordem de entrega e não reescreve o scorecard histórico `release-gate-v1` (`READINESS_SCORECARD_V1_20261102.md`), cujo 50/100 mede *prontidão de release* e não *percentual de desenvolvimento*. Não confundir os dois indicadores e não inventar um percentual novo sem baseline e critérios auditáveis.

## Fase A — DESENVOLVIMENTO (meta: 100% de engenharia)

Até a conclusão de todos os itens abaixo, o trabalho é implementação de código e integração. Testes automatizados e PostgreSQL isolado são parte da engenharia, mas **testes no WhatsApp de aparelhos e instalação local não são pré-requisito para concluir esta fase**.

| Critério de conclusão de engenharia | Estado verificado em 02/11 | Critério necessário para marcar concluído |
|---|---|---|
| Fluxo de exploração V4 completo no runtime destinado à futura instalação | **Parcial** | Preparar/buscar -> Outbox SENT -> Encounter ENGAGED -> menu com AÇÕES/CAPTURAR -> resposta citada verificada -> captura/PvE/ignorar por serviços canônicos, recovery/rollback; nenhum elo somente como teste desacoplado |
| Aparência e mídia da V4 | **Parcial** | Assets aprovados/licenciados e referências verificadas; decoração WhatsApp, hierarquia, textos e dobra nativa condicionada a suporte real do cliente, com fallback honesto |
| Batalha, PvP, equipe, Boxes, mundo e regras comunitárias | **Parcial/validado em módulos** | Códigos integrados na mesma candidata, nenhuma regressão cruzada ou rota concorrente; aceite do contrato V4 |
| Hub Premium | **Em andamento (PR #132 Draft)** | Fluxos de auth, sessão, APIs/site e bot integrados, contratos, testes automáticos de ponta a ponta em ambiente isolado; UAT em celular vem depois |
| Conteúdo e persistência | **Pendente** | Catálogo e pesos/odds/TRAIL publicados com aprovação, migrations numeradas/rollback e schema atual correspondente ao código |
| Proteção e portabilidade | **Pendente** | Rotina e documentação de backup criptografado e restauração automatizável, executadas/verificadas em clone isolado; jamais alterar DB ativo |
| Distribuição instalável | **Pendente** | Artefatos e procedimentos de atualização Windows/PM2 construídos e auditados SEM executar no PC ou serviço atual, incluindo verificação, rollback e conferência pré-cutover |
| Auditoria de engenharia | **Parcial** | Testes unitários, integração PG18, regressões, TypeScript, lint/build e checks de segurança completos no HEAD candidato |

**Definição do 100% de desenvolvimento:** somente quando todos os requisitos de engenharia acima estiverem completos, ligados e comprovados no HEAD escolhido. Não exige instalar na máquina do usuário nem passar por testes de Android, iOS ou WhatsApp Web nesta fase. Para rastrear percentuais futuros, definir uma régua separada e fixa de engenharia, sem reinterpretar os 50 pontos da régua antiga.

## Fase B — INSTALAÇÃO LOCAL CONTROLADA E HOMOLOGAÇÃO REAL

**Começa depois do 100% da Fase A**, por autorização explícita do proprietário. Inspecionar ambiente antes de qualquer comando: backups completos, restore comprovado, migrations, snapshots e processo PM2; só então instalar a candidata sem prejudicar usuários ativos. Depois testar WhatsApp Android, iOS e Web, mídia, citações, dobra, captura, PvE/PvP, concorrência, recovery e retrocompatibilidade. Bugs encontrados retornam à Fase A para correção e regressão; conclusão da instalação e dos testes NÃO deve ser falsamente contada como desenvolvimento prévio.

## Fase C — GO E ANÚNCIO

Só após homologação e autorização explícita. A PR #321 permanece Draft. Nenhum merge, deploy, PM2, Baileys ativo, sessão, banco de produção ou filesystem local foi tocado pela documentação ou pelo código de staging.

## Checkpoint 02/11

- Candidata: `Otiosun/sla`, PR #321 `fix/ux-world-route-access-policy-20261102`.
- Fluxos canônicos de captura, ignorar e PvE receberam provas reais em PG18 descartável. O conector de escolhas para o *runtime de desenvolvimento isolado* está em elaboração, sem ativação Baileys de produção.
- A dependência de UAT WhatsApp foi removida **da definição conceitual de 100% de desenvolvimento**, mas permanece indispensável para homologação e release.
- Próximo trabalho prático: finalizar as pontas de runtime e post-SENT/Outbox, assets V4, Hub, conteúdo/migrations, empacotamento e proteção; não se esconder atrás de mais testes de helpers isolados.

## Checkpoint de desenvolvimento — pós-SENT e emissão automática de menu V4

**Código verificado:** `116a8596be673345d541c726160a1895ddc51e1c` na Draft PR #321. **Ainda não é 100% da Fase A**; nenhuma pontuação de desenvolvimento foi inventada.

- A composição simulada de desenvolvimento agora instala efetivamente o `ExpeditionSearchPostSentHook` no `OutboxWorker` com um emissor `PostgresExpeditionOfflineActionableMenuIssuer`. Após a mensagem original de busca alcançar `SENT`, o servidor verifica o vínculo imutável player/outcome/Encounter/destino privado, ativa o Encounter via `EncounterService` e **só então** cria o menu `ACTIONABLE` no Outbox.
- O menu ainda carrega `expeditionSearch` para vínculo de proveniência, mas o hook **ignora mensagens com `expeditionMenu`**, impedindo emissão recursiva. Repetição da callback e corrida são idempotentes; o PG18 confirmou exatamente um menu para o mesmo outcome antes de iniciar o PvE canônico.
- `PostgresExpeditionPostSentRecovery` passou a recuperar `ENGAGED` quando a queda ocorreu **depois do encontro ativado, mas antes de emitir o menu**; a consulta exclui outcomes que já tenham qualquer snapshot de menu. Outbox pendente deve ser enviado pelo worker normal, sem regenerar mensagem.
- Com o hook de desenvolvimento presente, o `OutboxWorker` usa quarentena da entrega incerta (`quarantineUnknownDelivery`); a composição Baileys de produção sem hook conserva o comportamento anterior. O simulador expõe um registro de falhas pós-SENT para inspeção, em vez de silenciosamente tratá-las como sucesso.
- O fluxo de respostas privadas 0–4 continua conectado em modo explícito `APP_ENV=test`, `NODE_ENV=test`, `WHATSAPP_ENABLED=false` e exige todas as dependências de busca/captura/PvE; nenhuma dessas opções existe no construtor do runtime Baileys em produção.
- **CI:** [focada #41534751468](https://github.com/Otiosun/sla/actions/runs/41534751468) SUCCESS, 253/253 unitários, 37/37 PostgreSQL18, TypeScript, Biome 63 arquivos, build; [crossmodule #41534751354](https://github.com/Otiosun/sla/actions/runs/41534751354) SUCCESS, 828 PASS / 1 SKIP; [narrativa #41534751346](https://github.com/Otiosun/sla/actions/runs/41534751346) SUCCESS.
- **Faltam na Fase A:** emissão ponta-a-ponta da interface multimídia e hierarquia V4 com assets aprovados, contratos Hub Premium na mesma candidata, catálogo/odds/TRAIL e migrations numeradas com rollback, recuperação de outros estados não comprovados, backup/restore isolados e pacote Windows de atualização auditável. **Instalação local e testes reais de aparelho são apenas Fase B.**

## Checkpoint de desenvolvimento — roteamento contextual e apresentação V4 por estado (02/11/2026)

**Código auditado:** `ef79b0696bbb9722cc1f786fe0a57ef32ff6911f` da Draft PR #321. Este é avanço da Fase A, NÃO certificação de 100% e NÃO alteração do placar release-gate-v1.

- A rota `/explorar` de desenvolvimento agora resolve `/explorar 1` segundo a **fase persistida**: no estado `NONE`, preparar período DAY; em `PREPARING` ou `ACTIVE` quando o port de busca está instalado, executar `SEARCH_FREE` canônico, com custo de 30min somente pela transação do repositório. `/explorar 2` ou `/explorar dia` de menu antigo são rejeitados fora de `NONE`; nenhuma mutação indevida por reutilização do índice.
- Os status PREPARING e ACTIVE com busca habilitada usam os renderers aprovados V4 `renderExpeditionV4PreparingPanel` e `renderExpeditionV4ActivePanel`, exibem só a busca atualmente implementada. Recursos, viagem e encerramento não aparecem como opções numeradas inexistentes. `combiningCount=0` deixa o conteúdo integralmente legível enquanto falta calibração do Ler mais no aparelho; nenhum marcador editorial é enviado.
- `/explorar ajuda` foi implementado, coerente com `NONE`, `PREPARING`, `ACTIVE`, capacidade de preparação e presença/ausência do serviço real de busca. O painel de confirmação após preparo e a abertura deixam de negar a busca quando o port staging já está operacional.
- Proteção **antes da cobrança** em `PostgresExpeditionRepository.executeSearchFree`: após replay imutável e sob o bloqueio do jogador, um novo comando procura encontros `CREATED/PRESENTED/ENGAGED/CAPTURE_RESOLVING/IN_BATTLE` não resolvidos e recusa outra busca. Isso também bloqueia o caso `NO_SIGNAL`, que não invocaria `EncounterService.create` e antes podia consumir 30 minutos. O teste PG18 real prova recusa com tempo=30 anterior mantido e zero novo recibo; o replay autorizado continua antes da verificação.
- Prova CI do código: [focada #41538380463](https://github.com/Otiosun/sla/actions/runs/41538380463) **SUCCESS**: 259/259 Vitest, 37/37 PG18, TypeScript, Biome 63 arquivos, build; [cross-module #41538380446](https://github.com/Otiosun/sla/actions/runs/41538380446) **SUCCESS**: 834 pass / 1 skip; [Narrative #41538380530](https://github.com/Otiosun/sla/actions/runs/41538380530) **SUCCESS**: 7 testes de boundary.
- **Não realizado:** mídia/cenários licenciados, validação nativa Ler mais em aparelhos, recursos/viagem/finalização canônicos, conteúdo/TRAIL publish, Hub Premium, migrations, pacote instalável, backup externo/restore e instalação local. Não afirmar fases 100% ou liberação, não tocar PM2/Baileys/live DB.
