# Pokémon Beyond — Etapa 2 | Itens, golpes e progressão (WhatsApp literal)

**28/10/2026 | Protótipo editorial, não aprovado em cliente real.** Formatação propositalmente **literal**, sem renderizar asteriscos. [Ler mais] é indicação editorial e não payload. Nenhum Pokémon ou item fictício será concedido de verdade por estas cenas.

## Jogador iniciante — entendimento sem manual

\`\`\`text
JOGADOR: /pokemon #1

BOT:
◈ *POKÉMON*
  #1 · *Bulbasaur*

Nv. \`05\`   HP \`19/19\` (valor ilustrativo)
XP \`0/91\` · faltam \`91\` (apenas exemplo numérico)

◇ MOVIMENTOS
\`01\` Tackle
\`02\` Growl

\`/aprendizados #1\` · Quando aprende golpes
\`/golpes\` · Decisões pendentes
\`/evolucao #1\` · Requisitos
\`\`\`

**Nota:** números de HP e XP são ilustrativos; o bot real usa dados persistidos. O seed de teste atual registra Vine Whip no nível 7, não uma cópia oficial de Scarlet/Violet.

\`\`\`text
JOGADOR: /aprendizados #1

BOT:
✦ *𝗔𝗣𝗥𝗘𝗡𝗗𝗜𝗭𝗔𝗗𝗢𝗦*

◇ *Bulbasaur* · Nv. 05
  _Golpes por nível · catálogo da sua versão_

◇ *PRÓXIMOS NÍVEIS*
  Nv. 07 · Vine Whip

_Se existir vaga entre os quatro slots, aprende sozinho._
_Com quatro golpes, use /golpes para decidir._
\`\`\`

\`\`\`text
JOGADOR: /pokemart
BOT: [entrada e diálogo do comerciante]

JOGADOR: /comprar
BOT:
🛒 *𝗣𝗥𝗔𝗧𝗘𝗟𝗘𝗜𝗥𝗔𝗦*
  Poké Mart · Catálogo

\`01\` Poké Ball · ₽200
\`03\` Potion    · ₽300

› _Responda citando este menu com o número da mercadoria._

[Ler mais]
\`\`\`

**Loja:** somente exemplo com as duas ofertas do seed Phase 6; no runtime a consulta agora usa as ofertas **reais PUBLISHED** e seu preço atual. Não anunciar Great Ball, pedras, TM ou drops sem registro real. Códigos preservam a numeração estável da vitrine, inclusive lacunas entre 01 e 03.

## Jogador avançado — sem exploits nem falsos reparos

\`\`\`text
JOGADOR: /golpes

BOT:
✦ *MOVIMENTOS · APRENDIZADO*
◇ *Ivysaur*

Um movimento novo está pendente de decisão.

[Ler mais]

\`01\` Tackle
\`02\` Growl
\`03\` Vine Whip
\`04\` Leech Seed

\`/aprender 1 2\` · Substituir Growl
\`/aprender 1 pular\` · Preservar golpes
\`\`\`

\`\`\`text
JOGADOR: /aprender 1 2
BOT:
✦ *NOVO MOVIMENTO*

*Ivysaur* aprendeu *[golpe ofertado no catálogo]*.
\`02\` Growl → *[golpe ofertado no catálogo]*
     〔 APRENDIDO 〕
\`\`\`

Os nomes de movimentos ofertados são lidos do catálogo, não inventados pela Cena. Reenvio, duplicado, falta de slots, Pokémon estrangeiro, batalha em curso e menu antigo passam por validações autoritativas.

## Caso de bug histórico — não mentir ao treinador

\`\`\`text
JOGADOR: /evolucao #1

BOT ATUAL:
✦ *EVOLUÇÃO*

#1 · Bulbasaur · Nv. 20

1. Ivysaur
   Nível 16 · evolução automática

_Evoluções por nível acontecem automaticamente quando o requisito é atingido._
\`\`\`

**Problema:** o Pokémon já está acima do requisito, mas a antiga rotina normalmente só evoluía quando cruzava níveis. Não mandar o treinador gastar Pedra da Jornada (fixture artificial) ou ganhar +1 XP. O diagnóstico novo \`stage2_overdue_level_reconciliation.ts\` sinaliza casos e tem dry-run padrão. Ele não é comando para jogador nem foi aplicado a contas existentes.

\`\`\`text
BOT FUTURO (NÃO IMPLEMENTADO):
△ *PROGRESSÃO EM REVISÃO*

Seu Pokémon alcançou o requisito da evolução,
mas o registro ainda indica a forma anterior.
A equipe verificará as regras e o histórico.
Nenhum item ou experiência será consumido.
\`\`\`

O reparo operacional em ambiente de teste reaproveita \`ProgressionService.evolvePokemon\` com gatilho LEVEL e chave idempotente, sem mutação direta e sem subir XP. Caso envolva estatísticas relativas ou vários destinos, sinaliza revisão em vez de evoluir às cegas.

## Contratos de aceite

- Fonte base proposta: PokéAPI version_group scarlet-violet, outros grupos apenas quando documentados; **não é o catálogo completo publicado atual**.
- Levantar 100% das formas ativas, fontes de learnsets, itens e caminhos de evolução; bloquear incoerências e ofertas fantasmas.
- TM, tutor, reaprendizado, loot, drop e event quest só serão anunciados quando houver uma fonte real com transações e provas.
- UAT real e staging isolado antes de aprovar texto, expor reparo ou alterar dados de jogadores.
- Nenhuma alteração LIVE, pagamento, banco de produção, PM2, Baileys ou merge.
