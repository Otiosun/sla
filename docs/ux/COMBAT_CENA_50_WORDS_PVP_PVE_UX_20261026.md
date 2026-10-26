# Pokémon Beyond — UX de Cenas obrigatórias no combate (26/10/2026)

**Status:** decisão de produto para PvE e PvP; contrato de UX candidato, sem implementação de `/cena`, gate durável, contagem de palavras ou item de batalha. Documento de design na PR Draft #255, sem deploy nem alteração do bot ativo.

## Regras estabelecidas pelo usuário
1. O nome apresentado ao jogador é **Cenar / Cena** (não "narrar"). Cenar é obrigatório para ações voluntárias de combate. **Mínimo de 50 palavras narrativas por Cena**, tanto PvE quanto PvP.
2. Um único comando mecânico pode aparecer **no início, meio ou fim** do texto, inclusive com narrativa antes e depois. O texto livre não pode provocar efeitos; só a diretiva autorizada é interpretada. Um comando de ação por mensagem; bloqueio seguro para múltiplos ou ambíguos.
3. PvE: Cena e comando mecânico podem viajar numa só mensagem, no chat autorizado. PvP: o jogador pode preparar o comando secretamente no PV do bot e enviar `/cena` + pelo menos 50 palavras no grupo; ou combinar Cena + ação publicamente, sabendo que divulga sua escolha. Cena pública não precisa revelar golpe, item ou reserva.
4. Usar reply/quote para apontar o turno é opcional; reply isolado **nunca** registra Cena. Mensagens casuais não são cenas. `/cena` é marcador explícito novo para separar a Cena de uma ação privada. Se há referência explícita a turno antigo, falhar fechado sem registrar no atual. Se perdeu painel, `/batalha` recupera estado e `/cena` pode ser enviada sem reply, associada à única batalha ativa própria do chat de origem.
5. Para ações voluntárias, associar Cena e ação a `playerId + battleId + turn/version + chat autorizado`. Permitir qualquer ordem; submissão definitiva ao motor somente quando **ambas** estiverem válidas. Sem consumo antecipado de PP, Balls ou itens; replays/restarts/concorrência não duplicam ou reatribuem Cena.
6. Respostas do bot: preferir reação única a Cena confirmada, orientações privadas mínimas para Cena ausente/curta, resolução textual única para o grupo após o motor determinar os resultados. Bot não interpreta qualidade semântica, causação nem êxito da tentativa; staff modera abuso.
7. Cenar não deve impedir operações de desistência, encerramento administrativo ou recuperação de falhas. A política de deadlines e troca forçada pós-KO exige decisão específica antes de implementar.

## Contrato proposto para contagem
- Extrair a narrativa do corpo da Cena, excluindo comando(s) e parâmetros, o marcador `/cena`, formatação WhatsApp, URLs, código e mensagens citadas/reencaminhadas; contar palavras Unicode separadas por limites lexicais de forma determinística (incluindo acentos de português). Números puros, emoji, menções e repetição do texto original do bot não são palavras narrativas.
- Definir um único contador testável e reaproveitado entre PvE e PvP; rejeitar `<50` antes de criar um recibo de Cena válido. Mostrar uma correção curta `Sua Cena tem X/50 palavras; acrescente Y`, preferencialmente privada, sem divulgar dados de ação ou poluir o grupo.
- Se o jogador emite Cena e comando numa única mensagem com menos de 50 palavras, **não executar a ação** e não consumir recurso; fornecer rota de correção sem duplicar processamento. Não utilizar heurística que infira dano, item, alvo ou golpe de expressões em prosa.
- Para nomes de golpes/itens com múltiplas palavras, exigir fronteira inequívoca de argumento por expressão de catálogo ou linha; comandos numéricos continuam simples. Se argumento for ambíguo ou parecer parte de prosa, pedir correção. A diretiva pode ocupar qualquer posição, não apenas o rodapé.
- Mensagens citadas, códigos de exemplo ou payloads forjados não entram na contagem nem disparam ações; escape/ambiguidades exigem testes específicos.

## Estado da implementação auditada
- `src/modules/battle/scene-action.ts` reconhece `/movimento`, `/trocar`, `/capturar`, `/fugir`, `/desistir` em texto em qualquer ponto com limite de palavra e rejeita múltiplas diretivas; **não** conta palavras, não reconhece `/cena` ou `/item`.
- O parser existente lê para o fim da linha: `/movimento 2` com texto a seguir funciona porque lê o primeiro token numérico; **`/trocar 2` seguido de prosa na mesma linha pode falhar**, assim como comandos que recebem argumentos multi-palavra misturados à prosa. Ajustar sem ambiguidades antes de prometer suporte universal a começo/meio/fim.
- `BattleActionSchema` contém `USE_ITEM`, mas `src/modules/battle/legal.ts` não oferece itens em `legalActionsForParticipant`; `/item` não consta em `scene-action.ts`. **Item de batalha é pendente, não operacional.** Captura apenas WILD; `/fugir` para encontro selvagem, `/desistir` para PvP.
- PvP tem `/desafiar`, `/aceitar`, `/recusar`, `/cancelar` e TurnWindow, mas falta integração de decisão privada PvP + cena pública à mesma batalha, associada por identidade/chat/turno, sem vazamentos.

## Pendências para fechamento de implementação
1. Regra de expiração, abandono e resolução de turnos com ação/Cena incompletas; troca obrigatória e desistência.
2. Política de itens de batalha por formato e consumo transacional; reconciliação de captura direta numérica na Exploração com Cena de 50 palavras.
3. Testes com nomes/comandos no começo/meio/fim e na mesma linha; Unicode PT-BR, menos de 50, citação antiga, reply casual, dois comandos, jogadores simultâneos, mensagens em PV e grupo fora de ordem, replay/restart, privacidade do adversário, fallback de falha.
4. Prova headless em runtime isolado, CI, UAT WhatsApp e autorização de publicação. **Nenhuma dessas etapas é declarada pronta aqui.**

**Observação:** As cenas exemplificativas e os valores de batalha dos chats são simulações de UX, não resultados canônicos.

## Prazo PvP confirmado pelo usuário em 26/10/2026
- **12 horas por turno como padrão**, com alteração permitida somente a administradores autorizados do grupo PvP de origem; a alteração não afeta outros grupos.
- Comandos propostos (NÃO implementados): `/pvp prazo`, `/pvp prazo 6h` e `/pvp prazo padrão`. Configuração persistida e auditável por grupo, validada na camada de autorização.
- A duração efetiva de cada turno é imutável depois de aberto; mudança administrativa só afeta **o próximo turno**. Não reescrever deadlines de turnos ativos. Separar TTL do PvP da configuração atual de PvE (hoje ambos usam `pveBattleConfig.turnWindowTtlMs`, cujo default é 7 dias).
- A expiração, avisos e W.O. precisam ser implementados/testados de forma atômica; uma falha técnica de mensagens não deve ser interpretada como abandono do jogador.
- Limites mínimo/máximo de duração e antecedência do aviso ainda são decisões de política pendentes. Ver `docs/ux/COMBAT_CENA_PENDING_GATES_POLICY_PROPOSAL_20261026.md`.
