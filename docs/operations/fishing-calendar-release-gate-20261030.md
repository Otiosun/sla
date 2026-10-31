# Release 1 — Pesca: calendário do mundo (gate não publicado)

**Status:** NO-GO até aprovação expressa do fuso canônico da região e UAT real. Este documento operacional complementa, sem reescrever, as decisões de UX existentes no Google Drive e o gate [#264](https://github.com/Otiosun/sla/issues/264).

## Problema resolvido no candidato #282

A contagem de 5 pescarias diárias dependia de `CURRENT_DATE` do PostgreSQL, portanto o reset variava com o timezone da sessão/servidor em vez de usar uma regra explícita do jogo. A branch candidato agora gera a data `YYYY-MM-DD` com `fishingDayKey(clock.now(), approvedIanaTimeZone)`. O mesmo valor é enviado como parâmetro para a consulta do limite e para o INSERT de `fishing_attempts`, dentro da transação que também confirma o encontro.

* `FISHING_DAY_TIME_ZONE` é uma variável **de release**, não um valor deduzido do país/host/DB. Não existe default. Se ela estiver ausente, o serviço de pesca não é composto e a rota responde com mensagem explicativa, em vez de consumir quota sob um calendário desconhecido.
* O valor deve ser um timezone IANA validado (exemplos apenas para testes: `Etc/UTC`, `America/Recife`). **Nenhum desses exemplos foi aprovado como o fuso de Zhoulia.**
* Timezone inválido é erro de configuração no startup do serviço de pesca, antes de gravar SQL. Não mudar essa variável com o jogo ativo ou com tentativas em curso.
* A mesma mensagem, mesmo após virar o dia, recupera sua tentativa antiga pela chave idempotente persistida antes da contagem. Nova mensagem utiliza a data nova. D20, cinco tentativas e acesso por área permanecem canônicos.
* Testes PG18 descartáveis simulam 5 lançamentos às 23:59:59, sexta negativa, replay após 00:00:00 e primeira tentativa do dia novo, enquanto a sessão do banco opera com data UTC. O exemplo de timezone é só fixture.
* Não há migração nova nem alteração de registros de jogadores.

## Homologação antes de configurar o bot real

1. Administrador aprova por escrito o calendário IANA oficial e o horário do reset; registrar como decisão de mundo na fonte canônica quando a escrita do Google Drive estiver disponível.
2. Reconciliar catálogo ACTIVE PUBLISHED das áreas que oferecem pesca, inclusive raridades e Wooper UNCOMMON; não inventar pools.
3. Repetir PostgreSQL descartável + simulação WhatsApp com captura, expiração e replay, validar textos e grupos permitidos.
4. Conferir relógio sincronizado e data no PC/servidor, verificar backup e restauração antes de qualquer env ou migração real.
5. Só após GO explícito: configurar `FISHING_DAY_TIME_ZONE` durante a janela controlada de release, atualizar processo aprovado e observar logs e quota por dia, com rollback testado.

**Nunca** usar a produção como ambiente de ensaio, nem escrever em PM2, sessão Baileys ou banco real sem autorização expressa. A feature pode permanecer desligada independentemente dos demais módulos.
