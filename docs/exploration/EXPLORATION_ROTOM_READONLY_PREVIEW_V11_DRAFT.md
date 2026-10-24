# Exploração V1.1 — Rotom somente leitura (DRAFT)

## O que muda

Esta etapa não registra o comando `/explorar` e não envia mensagens aos jogadores.
Implementa **uma prévia tipada, isolada**, com um texto de apresentação na
identidade `ROTOM · EXPLORAÇÃO`, para o futuro fluxo de preparação/retomada.

O serviço `ExpeditionRotomPreviewService.inspect(playerId)` consulta:
1. `WorldService.getLocation` para confirmar o dono, o acesso ao mundo
   e a localização corrente;
2. `PostgresPublishedExplorationAreas.forActiveRelease` e o mesmo
   `inspectExplorationWorld` das PRs #247–#248 para bloquear release
   divergente, local não publicado, acesso não liberado e conexões ilegítimas;
3. `PostgresExpeditionPreviewReader.read` para ler, **numa única
   transação REPEATABLE READ READ ONLY**, uma expedição não encerrada,
   sua origem, cursor atual, fase, revisão e o total de cotas gastas
   na semana calculada no fuso configurado.

Se a localização do World não coincidir com o cursor persistido, a
prévia **falha fechada**, em vez de apresentar um menu enganoso.
O controle de semana usa `expeditionWeeklyAdmission`; expedições ACTIVE
podem continuar mesmo que as três cotas da semana estejam consumidas.

O formatador `renderExplorationRotomPreview` gera apenas texto:
- local atual;
- estado de sessão: nenhuma / PREPARING / ACTIVE;
- relógio de 12h internas e tempo restante quando há sessão;
- três cotas semanais e quantidade restante;
- conexões conhecidas e publicadas, **apenas para informação**;
- aviso explícito: consulta gratuita, viagens/ações ainda desabilitadas.

Quando a origem difere do local atual, a UI informa que ela foi
preservada no histórico. Não inventa o nome da área de origem sem uma
consulta ao catálogo correspondente. Os rótulos publicados são
normalizados para uma única linha, reduzindo risco de injeção de
marcação ou menus falsos.

## Por quê

O fluxo Vila → Yun → próxima ação da PR #252 já existe na camada SQL,
mas o jogador não deve receber opções de viagem ou cobrança sem custo
de conexão revisado e sem uma integração autorizada com WhatsApp.
Esta prévia separa **consulta** de **decisão transacional de escrita**.

## Regras de segurança

- Nenhuma chamada de `prepare`, `advance`, `executeNext`,
  `WorldService.travel`, `COMMIT` de mutação ou outbox.
- `actionsEnabled: false` em toda resposta; `canPrepareUnderPolicy`
  e `canContinueUnderPolicy` são apenas **informações de regra**, não
  autorização de execução ou feature flag live.
- Leituras do World e do resumo de expedição podem ocorrer em snapshots
  distintos; checar cursor ajuda a bloquear incoerências visíveis,
  mas NÃO substitui as revalidações sob locks na ação real.
- Nenhum valor de rota é introduzido. Rota Vila/Yun continua sem
  `explorationMinutes` oficial na release de produção.
- Sem cenas, imagem, botões, parser de intenções, migration numerada,
  PM2, alterações no C: ou publicação em produção.

## Provas previstas

Testes unitários: nenhuma expedição, PREPARING sem débito, ACTIVE após
viagem e com 3/3 cotas, incompatibilidade de cursor, coverage/release
ausente, trainer inelegível, contagem semanal inconsistente e saneamento
do rótulo em WhatsApp.

Teste PostgreSQL descartável: leitura PREPARING, avanço na fixture
para ACTIVE, leitura posterior da cota e conferência de que consultas
repetidas não aumentam os recibos.

Próxima etapa: sessão Rotom em sandbox com fluxos de navegação
somente leitura e cobertura de UX, sem ativar escolha de viagem;
posteriormente conciliar política de minutos da rota e
migração/cutover com backup restaurado de verdade.
