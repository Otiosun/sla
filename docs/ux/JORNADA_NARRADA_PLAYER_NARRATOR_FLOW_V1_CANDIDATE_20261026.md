# Pokémon Beyond — Jornada Narrada: UX end-to-end candidata (26/10/2026)

**Status:** proposta de UX da etapa 4 (Jornada e Narrativa), **não** implementação, aprovação final, deploy nem alteração do bot ativo. Vinculada à PR #255 Draft sem mesclar #257 Exploração Individual. Vocabulário: **Cenar / Cena**.

## Fatos auditados
- `src/modules/world-services/scene-proof.ts` já define `MIN_SCENE_PROOF_WORDS = 50` e contador estrutural para serviços da Jornada, com janela temporal de 15 min. Isso NÃO significa que existe prova coletiva generalizada de Cena por etapa da Jornada, nem que sessão narrada tenha TTL 15 min. Reutilizar/aperfeiçoar o contador sem reaproveitar indevidamente os prazos/escopos.
- `src/modules/encounter/spawn-whatsapp.ts` expõe `/spawn` autorizado por `encounter.support` e capability `pve`, exige menção real e checa co-localização do grupo, situação SPLIT e TRAVELLING. A chamada observada de `createOrReplay` passa `participantPlayerIds: []`: o simples fato de a party compartilhar local NÃO garante inserção dos aliados no mesmo combate. Portanto demonstrar spawn singular como fato e **não** prometer batalha coletiva automaticamente.
- `src/platform/encounter/postgres-narrator-spawn-context.ts` resolve os integrantes de `player_party_members`, área e bloqueio de deslocamento; WhatsApp group chat != co-localização canônica.
- `src/modules/narrative/service.ts` (`DEFAULT_NARRATIVE_N0_POLICY.enabled=false`), `src/modules/narrative/README.md`: IA narrativa N0 não pode alterar estado mecânico, acertar golpes, XP, recompensas ou posse. Narrador humano conduz prosa; bot executa apenas ações estruturadas/canônicas.
- `src/modules/battle/pve-scene-whatsapp.ts` reconhece comandos em prosa com parser existente, mas gate de 50 palavras por turno, `/cena` e contexto narrado coletivo NÃO estão implementados.
- `docs/exploration/EXPLORACAO_AUTONOMA_V1_BASELINE.md`: Jornada Narrada é distinta da Exploração Individual (relógio/cotas de expedição não entram automaticamente na Jornada); nenhuma reprodução mecânica do jogador por texto não autorizado.
- `docs/integration/FRONTEND_WHATSAPP_STYLE.md`: prosa em itálico, dados críticos sem itálico, narrativa antes do painel, comandos em monoespaçado; responder/reply não prova Cena.

## Princípio de produto
**Narrador conduz a ficção; jogador CENA e toma decisões; bot só atua onde há contrato mecânico.** A conversa continua livre; não exigir que narrador responda por meio de painel a cada fala. Interpretar texto em linguagem natural não fornece efeitos, progresso, pistas ocultas, loot nem bônus. Cenário/horário só afetam sorteio quando sincronizados com localização, ambiente, catálogo e estado canônico.

## Fluxo ideal ilustrativo
1. Narrador abre sessão por comando administrativo futuro opcional `/jornada iniciar @Jogador1 @Jogador2` com identidade, área e participantes verificados. **NÃO EXISTE** esse comando. Se não for criado, abertura manual do narrador segue sem automação; bot pode gerir mecânicas separadas.
2. Bot emite no máximo um painel de abertura contendo área válida, presentes, estado da Cena e instruções `/cena` (quando registro for necessário) e `/jornada` (consulta proposta). Nunca publica equipe privada, inventário, espécie secreta ou recompensa.
3. Narrador envia Cena ambiental em mensagem humana comum, sem reação automática do bot.
4. Jogadores enviam Cenas próprias de pelo menos 50 palavras quando a etapa **requer registro de participação/efeito mecânico**. `/cena` propõe registro explícito; sem reply obrigatório. Apenas uma resposta discreta/reação após persistência. Fala breve/diálogo casual continua permitido e não vira Cena validada. **Não** impor 50 palavras a cada interjeição do grupo nem reinterpretar citações.
5. Narrador gerencia a passagem entre marcos de história; bot não decide sozinho que uma pista foi encontrada porque alguém escreveu “encontrei”.
6. Quando há encontro real, narrador usa `/spawn @jogador` com elegibilidade de co-localização e regras de encounter. O próprio narrador não cria Pokémon extra apenas escrevendo ficção. O bot registra o encounter e envia uma mensagem curta; imagem de spawn contextual é trabalho visual futuro sujeito a curadoria/licenças.
7. Um jogador entra em combate PvE; Cena de 50 palavras + comando único em qualquer ponto da mensagem. Companheiro que só CENA apoio não recebe bônus e NÃO ingressa automaticamente na batalha. Cooperação genuína depende contrato explícito com participantPlayerIds/controle/autorização/recompensas; não prometer até desenvolver/testar.
8. Bot resolve combat/capture pelo motor, registra evento e publica resumo único; narrador pode interpretar suas consequências, jamais reescrever HP/captura por texto.
9. Narrador encerra o arco por prosa humana. Encerramento mecânico/summary auditável exigiria comando administrativo **futuro**, p.ex. `/jornada encerrar`, com checagem de encounter/battle ativos e snapshot canônico. Nenhum loot/XP/moeda automático por narrativa sem política e settlement reais.

## Política anti-spam e segurança
- Resposta/quote ao bot é contexto opcional, não registro de Cena. Mensagens comuns, provocação e conversa de participantes/espectadores não disparam bot; sem NLP criativo.
- /cena com texto 50+ palavras valida ator, grupo, sessão, etapa, autoria, cronologia; deduplicação por mensagem, e impedimento de duas participações válidas para a mesma obrigação. Falar depois continua livre.
- Mensagem <50 tem feedback gentil discreto `Sua Cena tem X/50 palavras; faltam Y`; não consome ação nem avança; nenhuma penalidade mecânica por fala informal.
- Narrador pode solicitar novas Cenas livremente, mas **novo marco administrativo do bot** só quando realmente precisa validar participação. Não numerar cada fala no WhatsApp.
- Pausa/retomada de sessão narrada: persistir estado/etapa; sem inventar W.O. PvP nem TTL de Expedição Individual; recupera após restart com `/jornada` proposto e valida co-localização novamente antes de novos atos mecânicos. Pessoas podem entrar/sair de Cenas por decisão do narrador, mas adicionar a uma batalha exige controle técnico e estado elegível.
- Se grupo dividido ou alguém viajando, o /spawn existente bloqueia. Nunca mover jogador automaticamente para coincidir com Cena do narrador. Múltiplas sessões elegíveis => falha fechada e seleção explícita, sem inferir.
- Narrador e admins devem ter permissionamento explícito; chat não confere poderes. Substituição de narrador requer auditoria; espectadores sem comando de mutação.
- Não republicar cenas privadas na mensagem de resultado, não inventar rewards; publicações/Outbox idempotentes e uma só vez.
- Time-of-day e ambientes não podem ser selecionados livremente pela aparência da imagem; usar catálogo/área/microhabitat/contexto real; a decoração não é fonte de regra.

## Gates técnicos
A. UX e política de sessão: escolher se `/jornada iniciar|status|pausar|retomar|encerrar` realmente é necessário, e escopo de `/cena` além de combate; evitar burocracia e spoilers. Definir mínimo de 50 palavras nas Cenas **formais** da Jornada; comando de gameplay só quando houver efeito canônico.
B. Persistência: narrator session/step/members/roles, autorização por grupo e área, SceneProof reutilizado/adaptado sem janela de instalação de 15min, receipts por ator/etapa/version, histórico, recuperação.
C. Encounters: resolver integração multi-player de fato; atualmente `participantPlayerIds: []` no comando do narrador, mesmo se party válida. Envolvimento só narrativo de aliados não implica combate cooperativo.
D. Encerramento: eventual quest state/objetivos/recompensas apenas quando existirem regras canônicas claras e transações seguras.
E. Testes: abertura, registro 49/50/51, turnos antigos, citações, 2+ jogadores, espectador, ausência, split/travel, troca de narrador, spam, crash/replay, spawn uma vez, PvE, nenhuma recompensa/XP indevida; simulação WhatsApp + PG descartável.
F. UX UAT e deploy só após aprovação explícita, CI e ambiente isolado. PR/Drive é design, não código vivo.

## Exemplo principal
Narrador: ambientação; Jogador1: `/cena` + tentativa longa de examinar pegadas; Jogador2: `/cena` + proteção do colega; narrador decide narrativa, sem bot responder; narrador: `/spawn @Jogador1`; bot mostra encounter canônico; jogador1: Cena 50+ /movimento 1; bot resolve; narrador interpreta aftermath; resumo somente fatos reais e nenhum loot inventado.
