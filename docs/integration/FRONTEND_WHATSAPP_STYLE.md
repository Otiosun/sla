# Bell — Front-end WhatsApp

Este arquivo é contrato visual do projeto. Alterações de UX devem preservar estas regras.

## Formatação nativa do WhatsApp

- `*texto*` = negrito. Use em títulos, nomes importantes e estados curtos.
- `_texto_` = itálico. Use para narração/cena, nunca para dados mecânicos críticos.
- `~texto~` = tachado. Reserve para conteúdo explicitamente cancelado/indisponível.
- `` `comando` `` = monoespaçado. Use para comandos, argumentos e exemplos.
- Não usar Markdown de web como `##`, `**negrito**` ou tabelas Markdown como linguagem visual do jogador.
- Separar cena e painel por uma linha vazia. Cena primeiro; comandos depois.
- UUID, slug, revision, release, CAS, idempotency key e nomes de tabela nunca aparecem para jogador.

## Identidade Rotom

A mensagem especial atual do Rotom — foto + legenda decorada — é asset protegido.
Menus contextuais usam a identidade Rotom, mas não repetem a foto a cada comando.

## Hierarquia visual

🌿 *ENCONTRO SELVAGEM*

_O mato se move. O narrador conduz a cena._

*Bellsprout* · Nv. 6

⚔️ `/batalha`
🔴 `/capturar`
💨 `/fugir`

## Exploração

Exploração não é grind automático. O narrador conduz a cena e usa o spawn administrativo.
Não existe comando do jogador que gere encontro aleatório sozinho.

## Localização

Encounter coletivo só pode ser criado para participantes mecanicamente co-localizados.
Grupo social não implica localização compartilhada.

## Estado técnico invisível

- Revisões, versões de batalha, UUIDs e slugs ficam internos.
- `/onde` apresenta rotas por número e nome humano.
- `/ir <número>` resolve a revisão atual internamente e continua replay-safe por idempotência.
- `/menu` prioriza Reception/ativação, depois BATTLE, ENCOUNTER, FACILITY e WORLD.

## Viagem curta

- `/ir <número>` inicia um deslocamento curto.
- Durante o lock de TRAVEL, `/menu` e `/onde` mostram apenas o estado compacto de viagem.
- Spawn do narrador é bloqueado se qualquer participante selecionado estiver em deslocamento.
- A duração padrão é 30 segundos e pode ser configurada por rota via `travelSeconds`.
- O cooldown especial de primeira chegada à Vila dos Arrozais permanece separado.

## Combate compacto

- PVE e PVP no WhatsApp traduzem o estado da luta de forma curta; o bot não vira guia de combate.
- O guia completo de combate fica fora da conversa.
- Movimentos do Pokémon podem ser consultados no bot e, depois, no Hub.
- Organização visual da equipe, ordem e troca de slots ficam para o Hub companion.

## POST_ARRIVAL não é TRAVEL

- POST_ARRIVAL preserva o cooldown especial de chegada e continua sendo regra do domínio de viagem.
- TRAVEL representa o deslocamento curto do jogador no front: impede novo `/ir`, `/onde`, menu WORLD normal e spawn narrativo até expirar.
- Serviços internos continuam podendo usar o domínio de World sem confundir deslocamento curto com o cooldown histórico de chegada.

## Spawn múltiplo

- O narrador usa `/spawn @treinador [quantidade]`; quantidade padrão 1, limite operacional atual 6.
- A quantidade é decisão narrativa. Espécie, nível, IVs, natureza, habilidade e movimentos continuam saindo do RNG canônico da área.
- Um grupo de selvagens é um único Encounter canônico com roster congelado; não são Encounters paralelos.
- O PVE recebe esse roster como a party selvagem do Encounter.
- O WhatsApp só mostra a lista compacta; IDs, slots internos, revisions e seeds nunca aparecem.
