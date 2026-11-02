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
