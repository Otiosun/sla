# Pokémon Beyond — proposta de fechamento dos gates de Cena/ação PvE-PvP (26/10/2026)

Status: **proposta concreta de política**, aguardando aprovação editorial; **NÃO IMPLEMENTADO**. Não alterar produção/PM2/DB/Baileys. Requer reconciliação com decisão-mãe docs/ux/COMBAT_CENA_50_WORDS_PVP_PVE_UX_20261026.md e PR #257 de Exploração.

## Evidências do código
- `src/runtime/pve-battle-runtime-config.ts`: `DEFAULT_TURN_WINDOW_TTL_MS = 7 * 24 * 60 * 60 * 1_000`; `PVE_TURN_WINDOW_TTL_MS` configurável.
- `src/runtime/compose-whatsapp-runtime.ts`: serviço PvP recebe `challengeTtlMs` e `turnWindowTtlMs` da configuração do PvE. Portanto, **não há prazo PvP diferenciado atualmente**; separar configs é necessidade de implementação.
- `src/modules/battle/turn-window.ts`: submissão após `deadlineAt` falha `TURN_WINDOW_EXPIRED`; não demonstramos política de W.O. automático/draw por falta de Cena. Não confundir rejeição de mensagens atrasadas com fechamento automático.
- `src/modules/battle/scene-action.ts`: parser `/movimento`, `/trocar`, `/capturar`, `/fugir`, `/desistir`; não há `/cena`, contagem de 50, nem `/item`. Recebe diretiva em prosa mas requer tratar nomes/argumentos de comandos em qualquer posição.
- `src/modules/battle/contracts.ts` tem `USE_ITEM`, porém `src/modules/battle/legal.ts` não oferece `USE_ITEM` em ações legais. Itens são planejados, não efetivos.
- `docs/ux/EXPLORATION_SHADOW_SCENES_20261025.md` na PR #257: menu numérico de Batalhar/Capturar/Ignorar é renderizador isolado, não rota live; encontro/captura são canônicos após retorno do serviço.

## Gate A — prazo e abandono
**Decisão editorial atualizada pelo usuário — PvP:** prazo PADRÃO de **12 horas por turno**, configurável por administrador autorizado do grupo que hospeda o confronto. Cada grupo PvP possui sua própria configuração persistente (escopo do grupo/tenant e checagem da capability administrativa), independentemente do PvE. Comandos administrativos propostos: `/pvp prazo` (consultar), `/pvp prazo 6h` (ajustar) e `/pvp prazo padrão` (restaurar 12h); esses comandos AINDA NÃO existem no runtime. A duração vigente deve ser congelada em cada nova BattleTurnWindow: alterações valem para **próximos turnos**, nunca retroativamente na janela aberta. Se não houver sobrescrita por grupo, usar default de 12h. Registrar autor/auditoria da alteração, validar duração positiva e dentro de limites seguros que ainda devem ser aprovados; consultar horas de término em texto simples no painel. Aviso privado único perto do término, quando Cena/ação estiver incompleta, sem spam; a antecedência exata deve ser configurada/testada para o prazo de 12h. Separar config e TTL de PvP do atual `PVE_TURN_WINDOW_TTL_MS`. Se vencido e exatamente um lado concluiu Cena >=50 + ação elegível, encerrar por W.O. favorável ao lado concluído; se nenhum concluiu, fechar sem vencedor e sem recompensas da luta. Se ambos concluíram antes do prazo, resolver uma vez, inclusive após atraso técnico de entrega; não puni-los porque o job atrasou. Se canal/serviço indisponível com evidência confiável, não dar W.O. automaticamente; pausa/reconciliação administrativa registrada. Inventário/PP só muda com execução real. Estado terminal de W.O. deve usar o caminho canônico de terminalização e aftermath, não write direto no status.
**PvE Individual:** usar ciclo de vida da Expedição/Encounter canônicos. Se não agiu, não resolver golpe nem gastar Ball. Expiração encerra sem sucesso fictício e libera bloqueios, de forma idempotente.
**PvE Narrado:** narrador/moderação pode suspender/retomar ou encerrar de forma auditável; sem golpe arbitrário por silêncio. Política de tempo da sessão narrada separada do PvP. Comandos de controle precisariam ser implementados/autorizados ou aproveitados de mecanismos canônicos verificados.

## Gate B — quais ações precisam de Cena
Cena de >=50 palavras narrativas para **ações voluntárias** (golpes, troca voluntária, item permitido, captura, tentativa de fuga). Cena no texto junto a uma diretiva em qualquer posição, ou marcador /cena separado da ação privada PvP; apenas uma diretiva mecânica por mensagem. /batalha, /moves, /equipe, menus e consultas NÃO exigem Cena.
**Troca forçada pós-KO:** deve ser Cenada como substituição com >=50 palavras, mesmo sendo escolha limitada. Não consumir ação de ataque extra além da mecânica canônica de troca forçada. Se vencer prazo sem troca/Cena, aplicar encerramento por ausência, não adivinhar reserva.
**/desistir e encerramento administrativo:** exceções explícitas: sair de uma batalha não fica condicionado a Cenar, para não aprisionar conta/usuário. Sistema informa resultado e protege replay/concorrência.
**Correção:** Cena curta informa contagem atual e quantas palavras faltam, sem aceitar ação/alterar estado. Texto casual, quote/reply, emoji e mensagem fora de turno/grupo não geram Cena. Contar prosa autoral Unicode, excluindo comandos, menções, números puros, citações e URL. Reação uma vez quando recebida.

## Gate C — itens
- Respeitar regraset/feature por modalidade e inventário no momento de execução, não basta haver comando.
- Proposta fase inicial: **PvE** permite consumíveis de cura/status em combate após whitelist/efeitos alvo transacionais; Poké Balls só em WILD via captura. **PvP 1V1 inicial** deixa consumíveis desativados até existir política explícita de formato/ranked vs amistoso; projetar interface para habilitá-los por ruleset mais tarde, sem presumir que já existem. Alternativa editorial: se autorizados no PvP, consomem a escolha do turno como movimento/troca e são limitados pela whitelist e quantidade; nunca permitir capture/flee por item. NÃO anunciar item que o motor não suporta.
- Quando autorização é ativada: validar item, alvo, carga, estoque, priority/effects, event logs e consumo atômico, incluindo replays, PP/HP e concorrência.

## Gate D — captura numérica da Expedição
- Escolher 1 Batalhar abre o contexto sem exigir Cena para navegação; primeiro ataque exige Cena >=50 + comando.
- Escolher 2 Capturar (ou outro número de Ball) prepara intenção de captura e exibe prompt **`Cene seu lançamento (50 palavras)`**; receber texto `/cena` (ou Cena+ `/capturar [Nome da Ball]`) confirma a tentativa após validar Ball canônica. Número só escolhe, NÃO consome Ball nem resolve.
- Escolher Ignorar/Voltar não exige Cena de combate, não inicia Battle; a regra de Cena aplica-se a ações de combate, não a navegação.
- Em nova tentativa após falha, precisa Cena nova de >=50, exceto se a mecânica canônica exigir estado diferente. Não herdar Cena de outra tentativa. Recibo idempotente para não reaplicar consumo de Ball, lançamento ou XP. Manter local, horário e release/contexto congelados conforme encontro canônico.

## Gate E — segurança/conciliação de grupo e PV
Um único `battleId + turnVersion + playerId` autorizado identifica Cena, ação preparada e estado. Um reply antigo explícito não é reinterpretado como novo turno; sem reply, /cena no grupo correto e jogador com única batalha ativa identifica turno atual. Comando no PV usa própria identidade; escolher opção não revela time, PP, reservas, move/item escolhido ao grupo. Ação e Cena chegam em qualquer ordem; gate durável faz commit ao motor **uma vez** somente quando ambos válidos. Bot reage à Cena sem mensagem nova, e único resumo público após resolução. Encaminhamento/citação/cópia de terceiros não conta como Cena autoral. Restarts, duplicação e atraso não geram action replay novo.

## Gate F — critérios mínimos de conclusão
1. Unitários: contagem PT-BR e Unicode, 49/50/51 palavras, comando início/meio/fim, frase depois de /trocar, itens com nomes compostos, dois comandos, texto malicioso/URL/quotes, Cena opcional de contexto mas obrigatória para agir.
2. Domínio: staging/expiry/W.O./pause, ambos ou nenhum completo, mudança de ação antes do gate segundo regras permitidas, slot de troca forçada, cancelamento/forfeit sem Cena; payload vencido.
3. Integração: dois jogadores em grupo+DM, ambientes com diversas batalhas, menções/reply stale, isolamento de privacidade e comunicação, W.O. sem recompensas indevidas, consumo 1x de item/Ball, 1 evento terminal por replay.
4. E2E: PG descartável, Inbox/Outbox + simulated WhatsApp, restart e duplicações, CI SHA exato; UAT WhatsApp sem alterar produção. Deploy somente depois de backup/restauração e aprovação do proprietário.

## Status
Proposta operacional registrada. **12h default por turno com prazo administrável por grupo PvP foi aprovado pelo usuário**, mas comando, persistência e segregação do TTL ainda precisam implementação/teste; política de item PvP, avisos e limites seguros ainda precisam decisão editorial. Nenhuma alteração de engine, migration, runtime ou bot ativo nesta etapa. Nenhuma alteração de engine, migration, runtime ou bot ativo nesta etapa.
