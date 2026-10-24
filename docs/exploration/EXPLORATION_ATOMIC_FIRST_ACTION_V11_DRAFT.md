# Exploração Individual V1.1 — primeira ação atômica (DRAFT)

## O que muda e por quê

A fundação `PostgresExpeditionRepository.advance()` avança relógio e
reserva uma das três expedições semanais, mas não executa o efeito do jogo
na mesma transação. Conectar o WhatsApp a esse método isoladamente poderia
cobrar tempo/cota sem realizar a ação. Não deve ser utilizado como rota
live.

`PostgresExpeditionFirstAction.execute()` estabelece um novo caminho,
ainda não conectado a nenhum runtime:

1. Revalida ponteiro `ACTIVE`, release e ruleset `PUBLISHED`, com lock
   compartilhado do ponteiro durante a escrita.
2. Bloqueia o treinador (`players FOR UPDATE`) e exige estado `ACTIVE`
   e onboarding `COMPLETE`.
3. Sob o mesmo lock, procura o recibo idempotente da mensagem. Se
   corresponder ao fingerprint, retorna a resposta preservada sem
   executar o efeito novamente; se divergir, rejeita.
4. Trava `player_locations FOR UPDATE`, confere revisão e confirma que a
   área é uma das duas habilitadas (Vila dos Arrozais/Campos de Yun),
   na release publicada, com encontros, formas e espécies ativos.
5. Recusa jogadores em encontro ou batalha em andamento e verifica que a
   área da expedição `PREPARING` ainda corresponde à localização.
6. Calcula a cota semanal segundo o fuso de mundo, aplica
   `advanceExpedition` e persiste o avanço **na transação em curso**.
7. Executa uma callback de efeito SQL **no mesmo `PoolClient`**, e
   persiste o resultado junto com o recibo na mesma transação.
8. Um `Result` de erro da callback ou uma exceção efetua `ROLLBACK`
   integral, inclusive após o relógio já ter sido atualizado.

O recibo usa chave derivada do Inbox com escopo exclusivo
`solo.exploration.first-action`; inclui fingerprint canônico do tipo,
parâmetros da ação, release, revisões e duração. O resultado do efeito
ficará registrado para retransmissão idempotente sem reaplicá-lo.

## Testes e limitações

Os testes de integração criam banco PostgreSQL descartável e uma tabela
**exclusivamente de prova**, `atomic_exploration_test_effects`, para
verificar sucesso, erro de domínio, exceção, replays, concorrência,
localização obsoleta, release trocada, limite semanal e ação de tempo zero.

Esta peça prova a **fronteira transacional**. Ela ainda NÃO cria efeito
canônico de caça, batalha, caminhada, coleta ou viagem. Não há definição
de duração em minutos de gameplay nesta mudança. O futuro implementador
precisa fornecer um efeito **somente SQL** aprovado, que utilize
obrigatoriamente o `PoolClient` recebido (nunca outra conexão, rede,
WhatsApp ou I/O externo) e validar requisitos específicos de desbloqueio,
horário, condições de encontro, itens e alvo sob o mesmo lock/transaction.
Sem esse efeito aprovado, o comando `/explorar` deve permanecer inativo.

O `PostgresExpeditionRepository.advance` antigo segue disponível APENAS
para provas de persistência da fundação, não como roteamento live.
A tabela `solo_expedition_receipts` permanece no esquema DRAFT,
`operation='ADVANCE'`; o JSON de resultado pode incluir `effectResult`.
Nenhuma migração numerada, PM2, banco real, sessão WhatsApp ou mainline
é modificado por esta PR.

## Próximas ações

- Implementar efeitos canônicos de exploração integrados a catálogo,
  World, Battle e Capture, sem duplicar regras de jogos.
- Rever política de durações e entrada/retorno em expedição no dossiê
  antes de publicar interface.
- Validar concorrência com operações do World e mensagens WhatsApp
  retransmitidas em ambiente descartável.
- Revisar migrações oficiais após o bloco Premium 0076–0078, simulação
  end-to-end e restauração privada comprovada antes de produção.
