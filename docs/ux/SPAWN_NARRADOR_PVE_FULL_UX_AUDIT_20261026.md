# Pokémon Beyond — Auditoria /spawn manual → Encounter → PvE e simulação de UX (26/10/2026)

**Projeto:** Otiosun/sla • **branch:** feat/combat-contextual-whatsapp-hud-20261024 • **PR:** #255 Draft.
**Estado:** design, auditoria estática dos fontes/testes e exemplos de mensagens **não executados**. Não houve execução de CI/WhatsApp ou mudança em runtime, banco, PM2 ou produção.

## Decisão de produto
Jornada Narrada é fluxo de RPG humano; narrador e jogadores Cenam livremente; bot não acompanha uma "sessão de Jornada". Somente aparece ao criar Encounter com /spawn, iniciar/controlar PvE, capturar, fugir, consultar /batalha e resolver resultado. Não implementar /jornada iniciar/pausar/encerrar/status, contagem automática de falas, menus de história ou recompensas por inferência textual.

**Regra Cenada já fixada:** para ações voluntárias elegíveis de PvE/PvP exigir >=50 palavras **narrativas** numa Cena; a única diretiva mecânica pode estar no começo, meio ou fim. Fora do combate, diálogos e cenas livres não precisam de /cena nem do mínimo mecânico. Em /spawn **sem ataque**, a própria criação administrativa não é ação de turno e não precisa simular gating de Cena. Em /spawn com ataque de abertura e decisões subsequentes de narrador/treinador, o requisito de Cena deverá ser integrado ao motor (ainda não está em runtime). Desistência/encerramento administrativo são exceções seguras. Não passar esse gating a cenas normais da Jornada.

## Mapa de código (fatos auditados)
- `src/modules/encounter/spawn-command.ts`: reconhece /spawn e modificadores `auto|automatico|automatic`, `shiny`, `nv|nivel|level|lvl` (1..100), `qtd|quantidade` (1..6), `inicio|comeca|primeiro jogador|selvagem`, `ataque|atk|mov|movimento`, espécie antes de modificadores estruturais, e quantidade legada `/spawn @jogador 3`. Proíbe auto+ataque e ataque+quantidade>1. Attack por nome/slot é validado contra o snapshot real do selvagem.
- `src/modules/encounter/spawn-whatsapp.ts`: /spawn aceita comandos embutidos via MessageRouter, requer `requiredGroupCapabilities: ["pve"]` e `requiredAdminCapability: "encounter.support"`, **exatamente 1 menção WhatsApp real**, alvo registrado, ambiente viável; rejeita party SPLIT/TRAVELLING. Cria Encounter via `encounters.createOrReplay` e observa com EncounterService antes de anunciar. Espécie/nível/shiny forçados somente se autorizados/catálogo válido. O parâmetro `participantPlayerIds: []` impede inferir que party acompanha combate coletivamente. A apresentação atual é predominantemente texto curto; proposta visual de imagem/fundo ainda não operacional no /spawn.
- `src/modules/messaging/router.ts`: extrai comando em qualquer posição onde `allowEmbedded` permite, preservando prosa em originalMessageText; teste em `tests/messaging/pve-spawn-whatsapp.test.ts` comprova /spawn ao final de Cena humana. `parseSpawnCommand` isolado exige /spawn no começo do *texto do comando* que recebe. Caso no meio da mesma linha/argumentos compostos precisa testes específicos; múltiplos comandos devem ser tratados como ambiguidade sem efeitos.
- Spawn NORMAL: publica ENCOUNTER `PRESENTED`, NÃO começa automaticamente Battle. Jogador usa ação autorizada `/movimento [1|nome]`, `/capturar [Ball]` ou `/fugir` na rota existente. Primeira ação que requer batalha chama `PveBattleStartService.startCanonical`: observe/engage/startBattle/BattleRuntime.initialize; um motor PvE.
- Spawn com `ataque`: valida contra os golpes do selvagem; `narratorOpening.start` cria Battle e registra movimento inicial do controlador NARRATOR. Não anunciar que já houve dano antes da resolução: "golpe definido" é o estado correto. Só 1 selvagem; erro de golpe inválido tenta `encounter.flee` como rollback seguro, mas exige testar caso compensação falhe.
- Spawn `auto`: `autoBattle.start`, `automatePlayers`, `kick` usando motor existente; sem mensagens a cada turno. Esse modo existe no código, mas sua compatibilidade com Cenar obrigatório em uma Jornada INTERATIVA precisa decisão/gate: recomendar uso somente administrativo/autorizado, não como atalho de combate narrado com rewards.
- `src/modules/battle/pve-scene-whatsapp.ts`: rotas `/movimento`, `/trocar`, `/capturar`, `/fugir`, `/desistir`, `/assumir`, `/automatico`, `/moves`, `/batalha`; permite narrador autorizado controlar selvagem e devolver à AUTO. /moves e detalhes privados do treinador não devem vazar no grupo. /capturar pode usar única Ball automaticamente ou listar disponíveis e aceitar nome. Em PvP /fugir orienta /desistir.
- `src/modules/battle/legal.ts`: sem `USE_ITEM` entre ações legais, embora tipo tipado exista. Não anunciar /item como utilizável; consumíveis são projeto pendente.
- `src/modules/battle/pve-battle-start.ts`: admin `/iniciarbatalha @treinador`, `/finalizarbatalha @treinador` (aliases encerrar/cancelar), autorizados por `encounter.support`; último encerra encounter/battle elegível sem simular vitória/reward.
- MULTIWILD: `spawnQuantity` até 6 forma **um** Encounter com roster congelado, 1 alvo selvagem ativo por vez. Quando um selvagem ativo é capturado, o resto pode continuar; captura requer Ball e contexto WILD, jogador proprietário; qualquer prêmio deriva de settlement canônico, não da UI.
- Testes auditados em `tests/messaging/pve-spawn-whatsapp.test.ts`, `tests/messaging/narrator-spawn-front.test.ts`, `tests/battle/pve-scene-whatsapp.test.ts`, `tests/runtime/multi-wild-battle-wiring.test.ts` e `tests/runtime/capture-flee-multi-wild-wiring.test.ts`. Presença de casos != prova de execução verde neste SHA.

## UX principal (proposta), mínimo de mensagens
Narrador: *O mato se move...* (livre); comando embutido ou separado `/spawn Poochyena @Lia nv 8`.
Bot: **ENCONTRO SELVAGEM** • Poochyena Nv 8 • Campos de Yun • Lia. Não mostrar UUID, release, seed. Apenas mostrar ações legalmente disponíveis; não forçar um /jornada novo.
Lia: Cena de >=50 palavras de preparação/tentativa com `/movimento 2` no início/meio/fim.
Bot: resumo de turno a partir do motor com dano verdadeiro e reação canônica; não adivinhar narrativa.
Narrador: continua a trama sem resposta do bot.

## UX do narrador quando deseja conduzir o selvagem
1. Spawn normal; bot publica ENCOUNTER.
2. Narrador decide iniciar o PvE com `/iniciarbatalha @Lia` (rota administrativa existente) ou já usa `/spawn ... ataque Bite`, quando autorizado. NÃO acrescentar menu de sessão.
3. /assumir @Lia na Battle (ou reply válido) vincula narrador ao selvagem ativo. /moves para consultar golpes elegíveis; /movimento [slot|nome] junto à Cena formal de >=50 palavras (regra nova a implementar). Se ação de narrador chega antes da resposta do jogador, guardar estado e reagir discretamente, sem spam.
4. /automatico @Lia devolve o selvagem ao controlador AUTO; nenhuma troca de titularidade/recompensa da batalha.
5. /finalizarbatalha @Lia só para sair de estado preso, não para forjar vitória ou premiação. Informar encerramento brevemente.

## Modos de aparição
A. Aleatório `/spawn @Lia`: espécie/contexto do encontro real.
B. Forçado `/spawn Poochyena @Lia nv 8 shiny`: elegibilidade contra catálogo e autorização, sem prometer força indiscriminada; interface opcional marca shiny se snapshot.confirmado.
C. Quantidade `/spawn @Lia qtd 3`: um Encounter, roster 3 selvagens, painel compacto, PVE considera apenas ativo; listar restantes se legitimamente conhecidos. Quantidade até 6; não criar 3 batalhas paralelas.
D. Iniciativa `/spawn @Lia inicio selvagem`: determina iniciativa inicial ao entrar no Battle. Não transformar em acerto automático.
E. Ataque `/spawn Poochyena @Lia nv 8 ataque Bite`: motor iniciado com golpe definido, porém resolução depende da janela. Não permitir `qtd 3 ataque Bite`.
F. Automático `/spawn @Lia auto`: motor automático; não usar como bypass das 50 palavras em interações que exijam participação Cenada.
G. /spawn embutido em Cena livre: texto autoral é contexto, não autorização para dano/loot. A diretiva administrativa é única e explicitamente autorizada.

## Resultado especial: captura, fuga e multiwild
**Captura:** `/capturar` com única Ball elegível; se várias, consulta amigável `/capturar Nome da Ball`. Somente Pokémon selvagem ativo, propriedade do treinador alvo, consume Ball apenas quando captura é efetivamente tentada. Sucesso significa TEAM ou BOX confirmado; falha processa o turno conforme motor, sem duplicar captura. Se havia outro selvagem vivo no roster, encontro segue.
**Fuga:** `/fugir` do jogador encerra ou tenta saída conforme contrato de encounter/battle; nunca conceder vitória e não pagar rewards inventados. **Admin recuperação:** `/finalizarbatalha` é terminal administrativo, não vitória.
**Mais de um Pokémon do treinador na battle:** /trocar aparece apenas se reserva controlada elegível existe, e deve passar gate de Cena de 50 palavras.
**Itens:** indisponíveis no front canônico auditado, não mostrar /item como opção.

## Casos de erro e mensagens propostas
- Não autorizado: "Você precisa da permissão de encontros para usar /spawn neste grupo." Nenhum Encounter criado.
- Menção digitada como texto, não menção real ou 2 menções: "Marque exatamente um treinador usando a menção do WhatsApp." Nenhum RNG.
- Alvo sem área válida: "Este treinador não possui localização válida." Sem spawn.
- Party dividida: "Participantes em áreas diferentes. Reúna o grupo ou escolha alguém da área." Sem spawn.
- Party viajando: "O grupo está em deslocamento. Aguarde o fim da viagem." Sem spawn.
- Encounter/battle já ativo: "Este treinador já possui encontro/batalha. Use /batalha para consultar; /finalizarbatalha apenas se precisar encerrar." Não criar segundo.
- Sem tabela ativa elegível: "Não há Pokémon elegíveis para este encontro nas condições atuais." Não fingir espécie.
- `nv 0` ou `nv 101`: rejeitar antes de criar.
- `qtd 0` ou `qtd 7`: rejeitar antes de criar.
- `auto ataque` ou `qtd 3 ataque`: rejeitar antes de RNG.
- Ataque sem nome, movimento não conhecido ou sem PP: explicar e não concluir golpe; caso encounter tenha sido criado, rollback /flee canônico com mensagem de estado verificável.
- Cena de batalha com 49 palavras: rejeitar comando até 50, sem PP ou item consumido, informando déficit no privado se possível.
- Mesmo comando repetido após atraso ou reconexão: replay idempotente, sem duplicar Encounter, captura ou XP.
- Mensagem respondida antiga, menção casual, narrador com múltiplos selvagens sob controle: não adivinhar alvo; pedir referência explícita.

## UX anti-spam
- Apenas mensagens no ponto de spawn, batalha pronta/ação resolvida e encerramento; narrador e jogador podem enviar texto normal sem resposta do bot.
- Preferir uma reação para confirmação individual e resposta textual para resultado mecânico; confirmar estado persistido antes da reação.
- Não vazar infos de inventário, equipe, opções de movimento ou controle do adversário desnecessariamente. No PvP privacidade é ainda mais restrita.
- Cena de jogador pode conter comando em qualquer ponto, desde que desambiguado; /spawn também é extraível do meio da mensagem pelo router, mas validar limites de linha e argumentos.
- Imagem e fundo: projeto visual proposto, não existe aqui garantia de asset aprovado; fallback limpo texto se não houver fundo local correto. Exigir espécie, cenário e hora compatíveis, direitos de uso, e nunca escolher cenário por ficção escrita se contradiz o encounter.

## Pendências para implementação
P0: Gate formal de 50 palavras para ações de PLAYER e NARRATOR no PvE; /cena quando ação for separada; parser robusto e garantia de uma diretiva; preservar /spawn embed.
P0: UI de /spawn normal, ataque e automático sem prometer efeitos já não confirmados; revisar alvo/menções/permissões/race/retry; testes reais.
P1: Ilustração de Pokémon em fundos adequados + acessibilidade/fallback; não inventar assets.
P1: Controle narrador/AUTO, casos multiwild e recuperação após restart.
P1: Captura e troca, limite de Ball, consumo transacional, nenhuma recompensa falsa.
P2: Combat cooperativo canônico para múltiplos treinadores, separado da Jornada (hoje participantPlayerIds: []). Política auto vs Cena formal exige decisão editorial se houver recompensa competitiva.
Provas: testes do parser e mocks + integração PostgreSQL efêmero + simulator WhatsApp + CI no SHA final + UAT antes de release. Não alterar bot ativo sem autorização.

## Decisão de escopo
Conservar Jornada humana: NÃO criar gerente de jornada, missão automática por Cena, login, cronômetro de capítulo, quórum de interpretação, validação do conteúdo semântico ou painel de falas.
