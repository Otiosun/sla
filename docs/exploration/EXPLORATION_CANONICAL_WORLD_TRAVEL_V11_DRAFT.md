# V1.1 — Viagem da expedição pelo World canônico (DRAFT)

## O que foi implementado

A primeira ação SQL da PR #249 pode executar uma viagem real do `WorldService.travel`
dentro da MESMA transação do relógio, cota semanal e recibo de expedição.
Em `src/platform/world/postgres-world-repository.ts`, o adaptador
`worldRepositoryForClient(client)` permite que o World use o `PoolClient`
já transacionado, sem criar outro `BEGIN` nem duplicar a mecânica de viagem.

`canonicalWorldTravelEffect()` (staging, **não conectado ao runtime**) verifica
a área de destino na release publicada do escopo inicial, delega ao
`WorldService.travel` canônico e converte o retorno (com Date/bigint) em
resultado JSON seguro para recibos do WhatsApp. A viagem conserva:
- bloqueios de rota/unlocks pela implementação atual do World;
- controle de player, onboarding, fluxo de batalha/encounter, revisão de local;
- cooldown e travas do World; contabilização de visita e recibo World;
- mesma transação com estado da expedição e recibo de primeira ação.

Caso a viagem seja recusada ou uma etapa posterior falhe, a transação
externa efetua ROLLBACK do relógio, quota, localização, visitas, cooldown
e recibos de World e Expedição.

## Importantíssimo: custo temporal não está publicado

O dossiê canônico diz **VIAGEM = custo da conexão real**, sem aceitar o
exemplo de 45 min como fato. O atributo `travelSeconds` da conexão World
é **cooldown real**, NÃO minutos internos de exploração. Esta PR não
define nem presume o tempo da conexão Vila dos Arrozais ↔ Campos de Yun.

Os testes com `minutes=30` usam apenas uma duração SINTÉTICA para verificar
a transação. O futuro chamador do `PostgresExpeditionFirstAction` deverá
fornecer minutos obtidos de política revisada e versionada por conexão/
release. Até isso estar disponível, **não conectar a efeito de viagem ao
parser, WhatsApp ou runtime de produção**.

## Provas na base descartável

Os testes em `tests/db/expedition-first-action-atomic.integration.test.ts`
preparam uma release publicada sintética de Zhoulia, duas áreas, uma conexão,
tabelas de encontro e treinador com onboarding concluído. Verificam:
- viagem real Vila → Yun e atualização de `player_locations`;
- visita, recibo World, recibo de expedição e quota/tempo no mesmo COMMIT;
- retransmissão não executa viagem novamente;
- falha após o World mover devolve localização, visita, tempo, quota e
  recibos ao estado anterior;
- destino sem encounter publicado é recusado.

Nenhum teste usa dados reais de jogadores. Não existem novas migrations,
invocações PM2, comandos live ou autorização para implantar.

## Próximo gate

- confirmar os testes remotos e reportar workflows cancelados sem chamar de sucesso;
- publicar política de minutos por conexão depois de conferir conteúdo canônico;
- provar viagem com unlocks/cooldown em competição com outras ações World;
- conciliar migração DRAFT após Premium 0076–0078;
- implementar V1.2 busca direta pelo EncounterService sem duplicar motor,
  com RNG auditável e efeitos na mesma transação, só após a V1.1 de viagem
  estar segura e aprovada.
