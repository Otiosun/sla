# Pokémon Beyond — Battle HUD vetorial V1 (candidato de design, 26/10/2026)

**Status:** protótipo local reproduzível e 7/7 testes Node isolados; aguardando aprovação visual. NÃO integrado ao bot, NÃO publicado; nenhuma alteração de PM2, Baileys, PostgreSQL ou runtime.

## Decisão de UX
- Uma imagem SVG 1200×720 renderizável em PNG via `sharp` já instalado, com sprites legítimos **frente/costas**, cenário vetorial DAY/NIGHT, duas barras de HP proporcionais, números HP/MAX, espécie, Nv., gênero, status, shiny, treinador, tipo PvE/PvP e turno.
- Interface textual no WhatsApp continua sendo principal. Um cabeçalho/estado curto fica visível; `[Ler mais]` guarda golpes, opções, detalhes, regra e histórico para iniciantes. Veteranos usam `/movimento <número>`, `/trocar <número>`, etc., sem expandir toda vez.
- **Não** enviar imagem após cada turno. Enviar no início, em troca relevante, status especial ou sob pedido do jogador; turnos comuns são textos curtos. O PvE/PvP já possui motor e rotas; HUD não cria um segundo combate.
- PvP NÃO revela movimentos submetidos pelo rival, seed ou estado privado; lado esquerdo sempre representa a perspectiva do viewer autorizado.
- Arte sem efeito mecânico, renderização pura de estado persistido. Não enviar recompensas, itens nem XP na imagem. Falha na mídia não bloqueia resposta textual.

## Prova técnica de protótipo
Pacote criado fora do repositório e entregue ao proprietário no chat: `pokemon_beyond_hud_v1.zip`. Contém `battle-hud.mjs`, `build-previews.mjs`, `battle-hud.test.mjs`, `gallery.html` e fixtures PNG/SVG de:
1. PvE noturno Treecko (23/27) × Shroomish (7/18), Campos de Yun, T02.
2. PvP noturno Pikachu (18/22) × Eevee (12/20, PAR), Natan × Daivi, T05.
3. PvE diurno com HP crítico (3/27, PSN) e oponente KO (0/18).

`node --test battle-hud.test.mjs`: 7/7 testes PASS em Node22 do protótipo local. Testados HTML/XML escaping, HP ilegais (fail-closed), modos, status/KO, rejeição de URL remota/SVG como sprite e render deterministic; também gerados PNG com CairoSVG local. **Isso não é CI da PR #255 nem prova do adaptador real Sharp/Baileys.** `package.json` do repo declara `sharp 0.35.5`.

## Pesquisa externa e direitos
- Referências: Pokémon Showdown (HP/status concisos); Scarlet & Violet (composição combate Pokémon), PokeAPI/sprites (sprites Gen V frente/trás PNG para exemplo).
- GitHub PokeAPI/sprites: https://github.com/PokeAPI/sprites
- A licença do repositório https://github.com/PokeAPI/sprites/blob/master/LICENCE.txt declara que **todo conteúdo de imagens é Copyright The Pokémon Company**. A disponibilização do repositório em CC0 não licencia automaticamente os personagens. **Não inserir sprites externos no repositório público nem distribuir no bot antes da avaliação de direitos e asset policy.**
- O HUD deve buscar sprites previamente curados e autorizados no catálogo/release e embuti-los como data URI validada, sem chamadas HTTP no renderer. Templates vetoriais próprios podem ser versionados independentemente.

## Integração futura
`BattleState` + perspectiva de player elegível + nomes/sprites da release pinada → `renderBattleHudSvg(model)` → `sharp(Buffer.from(svg)).png().toBuffer()` → Outbox mídia com legenda textual existente. Reuso/idempotência por version e viewer; fallback texto se mídia falhar.

**Próximos gates:** aprovação estética do protótipo, escala de sprites grandes/pequenos, licença dos assets, teste real de Sharp em CI, binding ao BattleState/canais de WhatsApp, simulação Android/iOS e gate de cutover. Não declarar HUD implementado no bot antes disso.