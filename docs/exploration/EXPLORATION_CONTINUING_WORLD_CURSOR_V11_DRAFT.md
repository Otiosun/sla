# Exploração V1.1 — retomada pós-viagem com cursor World durável (DRAFT)

## Por que a correção é necessária

Até a PR #251, a expedição persistia um único `area_id`, que era a
**área de origem**. A primeira ação podia executar uma viagem pelo World,
mas a próxima ação comparava o local atual do treinador com aquela origem
e, portanto, não distinguia **onde a expedição começou** de **onde o
treinador está agora**. Isso inviabilizava a continuidade depois de viajar.

## O que muda

1. O esquema SQL **DRAFT** da V1.1 agora possui
   `solo_expeditions.current_area_id`, com FK para a área. `area_id`
   segue como **origem imutável**, para histórico e relatório. Expedições
   abertas devem ter cursor, e as fixtures sintéticas ENDED legadas podem
   omiti-lo sem migrar dados vivos.
2. `ExpeditionSnapshot` expõe `areaId` (origem) e
   `currentAreaId` (cursor). `PostgresExpeditionRepository.prepare`
   inicia ambos na localização World; leitura e persistência mantêm o
   cursor coerente. Não há mudança em WorldService, teleporte ou
   desbloqueios globais.
3. `PostgresExpeditionFirstAction.execute` mantém o comportamento
   PREPARING inicial. Novo `executeNext` exige expedição ACTIVE,
   confere player/release/localização/estado de encontro, trava o
   treinador e a expedição, e chama `advanceExpedition` **sem debitar
   outra cota semanal**.
4. Em cada ação, após executar o efeito SQL canônico no PoolClient
   compartilhado, a transação lê novamente a localização World e
   persiste `current_area_id` junto do relógio/revisão/recibo. Se o
   efeito, a gravação ou a verificação de destino falhar, rollback total.
5. Se outro comando moveu a localização World por fora do fluxo,
   a divergência entre `currentAreaId` e `player_locations.area_id`
   bloqueia a nova ação, mesmo com `expectedLocationRevision`
   atualizado. Isso evita converter deslocamentos externos em viagens
   gratuitas dentro da expedição.
6. A nova operação usa escopo de idempotência
   `solo.exploration.next-action`, diferente da primeira ação,
   permitindo replay de uma ação posterior com recibo próprio, sem
   reexecutar efeitos.

## Testes

A fixture PostgreSQL descartável prova sequência primeira viagem
Vila dos Arrozais → Campos de Yun → segunda ação, origem Vila preservada,
cursor Yun persistido, relógio cumulativo, uma só cota semanal,
retry sem efeito duplo, divergência World bloqueada, rollback de ação
posterior e concorrência de duas próximas ações.

As durações 30 e 15 minutos nessa fixture são **somente números de
teste** (30 no trecho de viagem sintético já publicado na fixture);
não são custos oficiais de rota real nem criação de mecânica de caça.

## Limites

`executeNext` ainda aceita apenas callback de efeito SQL confiável e
não é exposto no runtime. Não há comando WhatsApp, efeito de caça real,
migração numerada, DB de jogador, PM2 ou merge. O World continua dono
de conexões, cooldown e desbloqueios. O próximo passo é preparar o
orquestrador de ações canônicas e a UX Rotom com custo publicado, UAT,
migração oficial pós-Premium e ensaio privado de recuperação antes do
deploy.
