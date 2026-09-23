# ZHOULIA REGION EXPERIENCE V1 — TASK CANÔNICA

## Repositório / higiene
Worktree canônico:
`C:\Users\natan\Downloads\pokemon-bot-local-demo`

Antes de editar:
1. leia `AGENTS.md`;
2. leia apenas o checkpoint lean atual relevante (`.superpowers/sdd/pve-pvp-v2/LEAN_STATE.md`, se existir);
3. rode `git status --short`;
4. NÃO imprima diff inteiro nem logs gigantes.

Não fazer:
- commit;
- push;
- merge;
- reset;
- clean;
- stash;
- alterações destrutivas;
- alterar `.env`;
- reabrir PVE/PVP;
- tocar em `/aprovar`;
- mexer em Exploration.

Preserve todo trabalho local atual, inclusive migrations 0046–0050 e UAT Bootstrap.

## Objetivo desta slice
Implementar o menor vertical slice correto de **ZHOULIA REGION EXPERIENCE V1** usando a arquitetura de mundo existente.

IMPORTANTE:
- Já existem `WorldService`, `player_locations`, `area_connections`, `/onde` e `/ir`.
- REUSE isso.
- NÃO crie outro travel engine.
- NÃO crie `/viajar`.
- `/explorar` e toda lógica exploração→encontro estão BLOQUEADOS para esta task.

A primeira prova ponta-a-ponta é **Vila dos Arrozais**.
As demais 5 imagens entram no pacote apenas como assets preparados para slices futuras; não invente conteúdo delas agora.

## Produto canônico
- Região inicial da campanha principal: **Zhoulia**.
- Área inicial: **Vila dos Arrozais**.
- Front de chegada deve ser imagem + caption narrativa curta.
- O texto completo do cliente é lore canônico; NÃO despejar tudo no WhatsApp.
- Primeira chegada e retorno devem poder ter texto diferente.
- Áudio/música: apenas deixar o contrato extensível/opcional; NÃO implementar envio de áudio nesta slice.
- Viagem: o cliente definiu `cena → comando → bot coloca no local → espera 5 minutos para continuar`.
  Para esta slice, preserve o travel existente e modele os 5 minutos como **cooldown pós-chegada**, não como deslocamento assíncrono.
- Como Exploration está bloqueada, o cooldown precisa bloquear pelo menos uma nova `/ir`. Não invente outras ações bloqueadas.
- Rotas/conexões definitivas entre as seis regiões NÃO estão decididas; não crie grafo novo.
- Requisitos futuros (Ginásio/proficiência) continuam vindo das `area_connections/access_rule`; não hardcode política nova.

## Conteúdo — Vila dos Arrozais
Título:
`〔 🌾 VILA DOS ARROZAIS 〕`

Primeira chegada:
`Uma pequena vila surge entre extensos arrozais, canais de irrigação e campos verdes.

Casas simples se agrupam próximas ao rio, enquanto caminhos de terra seguem entre plantações e pequenos bosques.

Mais adiante, o rio se divide em diversos canais que atravessam toda a região.

Apesar da tranquilidade, barreiras construídas contra as enchentes revelam que nem tudo permanece tão estável quanto parece.

📍 VOCÊ CHEGOU — VILA DOS ARROZAIS`

Retorno (compacto):
`Os canais voltam a surgir ao lado da estrada. Mais adiante, telhados baixos aparecem entre os campos inundados.

📍 VOCÊ RETORNOU — VILA DOS ARROZAIS`

Lore canônico revisado (persistir em configuração/conteúdo somente se o modelo atual comportar isso sem schema desnecessário; não precisa renderizar inteiro):
`A primeira ambientação de ZHOULIA é uma pequena vila rural cercada por uma enorme extensão de arrozais, canais de irrigação e campos verdes. As casas são simples, construídas próximas umas das outras, com pequenos comércios, plantações familiares e caminhos de terra conectando a comunidade aos campos.

Um grande rio passa próximo à vila e se divide em diversos canais menores, utilizados tanto para irrigação quanto para transporte. Ao longe, é possível observar pequenas montanhas cobertas por vegetação.

A área ao redor da vila é completamente aberta. O treinador pode atravessar os arrozais, seguir os canais, explorar pequenos bosques e encontrar Pokémon vivendo livremente pelo ambiente.

A vila funciona como o primeiro ponto seguro da jornada, possuindo um Centro Pokémon, pequenas lojas, uma área comunitária e uma antiga casa utilizada pelos moradores para armazenar sementes e ferramentas agrícolas.

Apesar de tranquila, a região já apresenta sinais das mudanças que afetam ZHOULIA. Algumas partes dos arrozais possuem pequenas barreiras contra enchentes e determinados canais foram reforçados pelos moradores.

Durante períodos de chuva, o nível da água sobe consideravelmente e algumas áreas dos campos ficam temporariamente alagadas, criando novos locais onde Pokémon aquáticos podem aparecer.`

Não criar Santuário/Xamã como localização técnica nesta slice.

## Assets
O pacote foi preparado para ser extraído na raiz do repo.

Principal desta slice:
`assets/regions/zhoulia/vila-dos-arrozais.jpg`

Outras imagens principais já preparadas, mas NÃO implementar conteúdo delas ainda:
- `assets/regions/zhoulia/campos-de-yun.jpg`
- `assets/regions/zhoulia/floresta-de-sekigloom.jpg`
- `assets/regions/zhoulia/cidade-do-aquario.jpg`
- `assets/regions/zhoulia/porto-dos-ceus.jpg`
- `assets/regions/zhoulia/templo-do-ceu-antigo.jpg`

## Media: restrição técnica
O adapter atual trabalha com IMAGE por HTTPS URL.

NÃO enfraqueça a política HTTPS e NÃO aceite `file://`.

Faça a slice de modo que:
- haja configuração opcional para URL HTTPS da imagem da Vila;
- IMAGE + caption quando configurada;
- fallback TEXT com a mesma caption quando não configurada;
- asset local acima fica preparado para publicação/hosting, não força mudança insegura no adapter.

Siga o padrão existente de `world-service-media-runtime-config` quando isso reduzir código.
Evite criar sistema genérico de CDN/assets.

## First visit vs return
Precisa ser durável.

Antes de criar schema novo, procure no estado ATUAL por histórico/visitas já existente.
Se NÃO existir mecanismo reutilizável:
- crie a menor migration NOVA disponível após a 0050 (provavelmente `0051_...`);
- NÃO altere migrations aplicadas;
- persista somente o mínimo necessário para distinguir primeira chegada de retorno.
Evite um “analytics system”.

A primeira localização criada no onboarding/UAT conta como primeira visita.
Migração deve ser compatível com jogadores já existentes.

## Cooldown de 5 minutos
Antes de criar schema, procure estado/histórico reutilizável.
Se necessário, persista o mínimo por jogador.

Sem inventar travel assíncrono:
1. `/ir` válido continua movendo imediatamente;
2. resposta de chegada é emitida;
3. até `arrival + 5min`, nova `/ir` falha amigavelmente com tempo restante;
4. após cooldown, `/ir` volta a funcionar;
5. idempotent replay da mesma mensagem não deve estender cooldown nem contar nova visita.

Use Clock/injeção de tempo existente se houver. Não use sleeps/timers.

## UX
Não exponha:
- UUID;
- revision interna desnecessariamente na resposta final de chegada;
- nomes de enum/status internos.

Preserve `/onde` e `/ir` existentes. Não quebre aliases/policies.

Arrival com imagem:
- 1 mensagem IMAGE com `imageUrl` + `caption`;
- não mandar TEXT duplicado depois.

Fallback:
- 1 TEXT.

Cooldown:
`⏳ Você acabou de chegar a *Vila dos Arrozais*.
Aguarde *3min 42s* antes de seguir por outra rota.`

## Testes focados obrigatórios
TDD / focused first.

Cobrir pelo menos:
1. Vila dos Arrozais possui apresentação canônica.
2. primeira chegada usa `firstArrival`.
3. retorno usa texto compacto.
4. IMAGE + caption quando URL HTTPS configurada.
5. fallback TEXT quando mídia ausente.
6. chegada inicial criada pelo onboarding/UAT é registrada sem duplicar visita.
7. `/ir` move imediatamente e inicia cooldown de 5 min.
8. nova `/ir` durante cooldown é negada sem mover.
9. `/ir` após 5 min funciona.
10. replay idempotente não aumenta visit count nem reinicia cooldown.
11. migration/backfill funciona para `player_locations` pré-existentes.
12. `/onde` continua funcionando.
13. regressão mínima WorldService travel/access rules.

## Gates
Rode somente o necessário:
- testes novos/focados;
- testes WorldService/operational UX tocados;
- migration integration focada;
- Biome apenas arquivos tocados;
- `git diff --check`;
- `pnpm typecheck` apenas no fim.

Baseline conhecido:
`pnpm typecheck` pode continuar bloqueado EXCLUSIVAMENTE pelos 3 erros pré-existentes em:
`tests/capture/capture-service-seed-context.test.ts`

Qualquer erro novo é regressão.

## Stop condition
Se algo exigir decisão de produto NÃO coberta acima, PARE antes de inventar e reporte a decisão exata.

Se tudo passar, marque:
`ZHOULIA_REGION_EXPERIENCE_V1_GREEN`

Entregue só:
- arquivos alterados;
- migration criada;
- testes/gates;
- como configurar a URL HTTPS da imagem;
- roteiro WhatsApp mínimo para provar primeira chegada, retorno e cooldown.

Não avance para Campos de Yun.
Não implemente Exploration.
