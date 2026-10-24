# V1.1 — Admissão de mundo para exploração individual (DRAFT)

## Mudança e motivo

A fundação V1.1 já persiste o relógio, a fase da expedição e a cota semanal,
mas `PostgresExpeditionRepository.prepare()` ainda lê a localização sem
confrontá-la com a release publicada, os bloqueios de mundo ou as tabelas de
encontro realmente disponíveis. Por isso **não pode alimentar /explorar no
runtime ativo**.

Esta etapa adiciona somente `inspectExplorationWorld()`: uma **inspeção pura,
sem escritas**, tipada com a visão existente de `WorldService.getLocation()`.
A função recebe também uma lista de áreas que um adaptador **confiável** terá
verificado na release ativa, com tabelas de encontros publicadas. Nenhum
adaptador é inventado ou conectado neste PR.

## Comportamento

- Exige identidade do jogador e ID da release correspondentes ao contexto.
- Reprova local exigindo realocação, região fora de Zhoulia, área fora do
  escopo inicial Vila dos Arrozais/Campos de Yun ou área sem tabela de encontro
  efetivamente publicada.
- Mostra apenas conexões fornecidas pelo World, disponíveis, sem desbloqueios
  pendentes, para a outra área do lançamento que também esteja publicada.
  **Nunca** cria teleporte, rota ou custo de viagem arbitrário.
- Não consome cota, tempo interno, Ball, recursos nem muda localização.
- Não consulta Pokédex para liberar espécie, não ativa encontros nem integra
  as quatro áreas adicionais autoradas.

## Limite de segurança

É apenas **pré-checagem de leitura**, útil para a futura preparação de menu.
A autorização da primeira ação precisa repetir o controle na mesma transação
PostgreSQL com lock do jogador/localização, débito de cota + relógio e efeito
canônico (viagem, busca etc.), com recibo idempotente. Uma checagem fora da
transação é insuficiente contra mudanças concorrentes ou nova release.

Para o próximo passo, construir um provider read-only das tabelas ativas
associadas ao `contentReleaseId` exato, sem usar pools draft, depois o
orquestrador transacional. A duração em minutos de viagens é pendência do
dossiê canônico; `travelSeconds` do mundo controla outra política de
cooldown e **não** deve ser convertido em minutos internos por suposição.

Não foi criada migração, comando WhatsApp, feature flag nem conexão com
produção. Os testes deste PR usam objetos sintéticos, sem dados de jogadores.
