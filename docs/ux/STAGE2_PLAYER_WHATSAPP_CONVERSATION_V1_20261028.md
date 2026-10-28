# Pokémon Beyond — Etapa 2: simulação de um jogador no WhatsApp (UX V1 CANDIDATA)

**28/10/2026.** Documento de UX; NÃO são saídas literais já implantadas. Mecânicas e escolhas seguem UAT 44/44 com PostgreSQL descartável: https://github.com/Otiosun/sla/actions/runs/40576174445 e https://github.com/Otiosun/sla/blob/feat/pokemon-management-stage2-20261027/docs/operations/stage2-player-journey-uat-20261027.md.
Identidade visual: https://github.com/Otiosun/sla/blob/feat/exploration-whatsapp-shadow-scenes-20261025/docs/ux/EXPLORATION_PLAYER_FLOW_UX_V4_APPROVED_20261026.md.

## Contrato de apresentação
- Simular pessoa → comando → mensagem visível do bot → escolha/resposta → resultado persistido. Não substituir isso por lista de testes ou tela do Hub.
- Topo acima da dobra: título com personalidade, identificação, principal estado/resultado. Depois da dobra: ações, saldos, explicações e ajuda. Confirmar ações sensíveis e erros curtos SEM dobra.
- [Ler mais] = marcador editorial da dobra, nunca texto literal enviado. U+031D foi testado pelo usuário no Android, porém exige homologação Baileys e acessibilidade antes de produção. Não inserir caracteres repetidos indiscriminadamente.
- Tudo em blocos textuais literais para preservar os asteriscos e underscores da formatação WhatsApp. Eventos de fixture não devem parecer conteúdo publicado.
- Nos fluxos de PC, responder 01/02 CITANDO o prompt do bot, com replyToExternalMessageId. Números avulsos não devem ser tratados como permissão universal.
- Usar 0/1/2 e comandos somente quando habilitados no estado atual. Não oferecer ação de nível manual ou item sem saldo nem prometer sucesso antes de uma transação.

## Ator e premissas da simulação
Treinador A em Vila dos Arrozais, Bulbasaur nível 5 (20/20 HP) na Equipe 01; Segundo treinador B sem item. Os nomes *Eco da Jornada* e *Pedra da Jornada* existem APENAS na fixture sintética. O caminho Bulbasaur→Ivysaur por pedra também é FICTÍCIO e não é uma evolução canônica publicada. Usar esses dados apenas como prova de mutação idempotente; consultar catálogo real para exemplos futuros.

### Cena 1 — /equipe /pokemon #1
```text
JOGADOR: /equipe
BOT:
◇ *𝗘𝗤𝗨𝗜𝗣𝗘 𝗣𝗢𝗞É𝗠𝗢𝗡*
⚡ `01 / 06` Pokémon ativos
◇ *Bulbasaur* ● `Nv. 05`
HP `20/20` · Posição `01`
[Ler mais]
◇ *𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔𝗥*
▣ `/pokemon #1` · Ficha
▣ `/colecao` · Todos os Pokémon
▣ `/box` · Armazenados
◇ *𝗚𝗘𝗥𝗘𝗡𝗖𝗜𝗔𝗥*
↑ `/equipe colocar <#> [slot]`
↓ `/equipe guardar <#>`

JOGADOR: /pokemon #1
BOT:
◈ *𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗢 𝗣𝗢𝗞É𝗠𝗢𝗡*
◇ *Bulbasaur* ● `#01`
Nv. `05` · HP `20/20`
⌖ Equipe · Posição `01`
[Ler mais]
◇ *𝗗𝗔𝗗𝗢𝗦*
Nature · Bold | Ability · Overgrow
XP · `0`
◇ *𝗜𝗩𝘀*
HP `17` · Atk `07` · Def `09`
SpA `14` · SpD `05` · Spe `10`
◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*
1. Growl · PP `40/40`
2. Tackle · PP `35/35`
✧ `/golpes` · Aprendizado
✧ `/evolucao #1` · Requisitos
```

### Cena 2 — /golpes /aprender
```text
JOGADOR: /golpes
BOT:
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗔𝗣𝗥𝗘𝗡𝗗𝗜𝗭𝗔𝗗𝗢*
> _Bip! Bulbasaur quer aprender um novo movimento!_
◇ *Bulbasaur* ● `Nv. 05`
✧ *Eco da Jornada* · `PENDENTE`
[Ler mais]
◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*
1. Growl
2. Tackle
◇ *𝗗𝗘𝗖𝗜𝗦Ã𝗢*
`/aprender 1 1` · substituir Growl
`/aprender 1 2` · substituir Tackle
`/aprender 1 pular` · manter atuais

JOGADOR: /aprender 1 9
BOT:
△ *𝗦𝗟𝗢𝗧 𝗜𝗡𝗩Á𝗟𝗜𝗗𝗢*
> _Escolha um movimento ocupado de 1 a 4 ou use pular._
`/golpes` · Rever escolhas

JOGADOR: /aprender 1 1
BOT:
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗡𝗢𝗩𝗢 𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢*
◇ *Bulbasaur*
✧ *Eco da Jornada* · `APRENDIDO`
[Ler mais]
◇ *𝗔𝗟𝗧𝗘𝗥𝗔ÇÃ𝗢*
Slot `01`: ~Growl~ → *Eco da Jornada*
Os demais movimentos foram preservados.

JOGADOR: /golpes (segunda oferta do mesmo golpe em fixture)
BOT:
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢 𝗥𝗘𝗣𝗘𝗧𝗜𝗗𝗢*
◇ *Bulbasaur* já conhece *Eco da Jornada*.
[Ler mais]
Não substitua nenhum golpe; descarte a oferta duplicada.
`/aprender 1 pular`

JOGADOR: /aprender 1 pular
BOT:
◇ *𝗔𝗣𝗥𝗘𝗡𝗗𝗜𝗭𝗔𝗗𝗢 𝗘𝗡𝗖𝗘𝗥𝗥𝗔𝗗𝗢*
> _Os movimentos de Bulbasaur foram preservados._
```

### Cena 3 — /evolucao /evoluir /inventario
```text
JOGADOR: /evolucao #1
BOT:
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗩𝗢𝗟𝗨ÇÃ𝗢*
◇ *Bulbasaur* ● `Nv. 05`
✧ Destino conhecido: *Ivysaur*
[Ler mais]
◇ *𝗥𝗘𝗤𝗨𝗜𝗦𝗜𝗧𝗢𝗦*
1. *Ivysaur* · Nível `16`
   _Evolução automática ao receber XP._
2. *Ivysaur* · Pedra da Jornada `×2`
   _ITEM APENAS DA FIXTURE DE TESTE_
   `/evoluir #1 2`

JOGADOR: /evoluir #1 1
BOT:
△ *𝗘𝗩𝗢𝗟𝗨ÇÃ𝗢 𝗔𝗨𝗧𝗢𝗠Á𝗧𝗜𝗖𝗔*
> _A evolução por nível acontece quando o Pokémon recebe XP. Não pode ser forçada por comando._

JOGADOR B: /evoluir #1 2 (sem pedra)
BOT B:
△ *𝗜𝗧𝗘𝗠 𝗜𝗡𝗗𝗜𝗦𝗣𝗢𝗡Í𝗩𝗘𝗟*
> _Você não possui Pedra da Jornada._
Nenhum item foi consumido.

JOGADOR A: /evoluir #1 2
BOT:
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗩𝗢𝗟𝗨ÇÃ𝗢 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔*
✧ *Bulbasaur* → *Ivysaur*
　　　　〔 `CONCLUÍDA` 〕
[Ler mais]
◇ *𝗔𝗧𝗨𝗔𝗟𝗜𝗭𝗔ÇÃ𝗢*
Forma registrada · Ivysaur
Pedra da Jornada · `×2 → ×1`
`/pokemon #1` · Ficha
`/inventario` · Itens

JOGADOR: /inventario
BOT:
🎒 *𝗜𝗡𝗩𝗘𝗡𝗧Á𝗥𝗜𝗢*
Pedra da Jornada · `×1`
```

### Cena 4 — PC / depósito / retirada / organização
```text
JOGADOR: /pc (fora do Centro)
BOT:
△ *𝗣𝗖 𝗜𝗡𝗔𝗖𝗘𝗦𝗦Í𝗩𝗘𝗟*
> _Entre no Centro Pokémon com /centropokemon para acessar o terminal._

JOGADOR: [narra a entrada no Centro, conversa livre]
BOT: [permanece calado; a Jornada continua humana]

JOGADOR: /centropokemon
BOT: [mensagem de ambientação original preservada, com Enfermeira Hana]

JOGADOR: /pc
BOT:
▣ *𝗣𝗖 𝗣𝗢𝗞É𝗠𝗢𝗡*
　　　　〔 `CONECTADO` 〕
◇ Equipe ● `01 / 06`
▣ Caixas ● `01 / 30`
[Ler mais]
◇ *𝗔ÇÕ𝗘𝗦*
▣ `/caixas` · Ver armazenados
↓ `/depositar` · Guardar
↑ `/retirar` · Trazer à equipe
↻ `/organizar` · Mover nas caixas
‹ `/sair` · Sair do terminal

JOGADOR: /depositar (apenas 1 Pokémon na equipe)
BOT — UX PROPOSTA, diferente do menu atual:
△ *𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢 𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗢*
> _O último Pokémon da equipe não pode ser guardado._
↑ `/retirar` · Trazer outro Pokémon primeiro

JOGADOR: /retirar
BOT:
↑ *𝗥𝗘𝗧𝗜𝗥𝗔𝗥 𝗣𝗢𝗞É𝗠𝗢𝗡*
▣ *Ivysaur* · Caixa 01 / Vaga 01
[Ler mais]
`01` Escolher Ivysaur
> _Responda citando esta mensagem._

JOGADOR [cita menu]: 01
BOT:
↑ *𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗥𝗘𝗧𝗜𝗥𝗔𝗗𝗔*
◇ Ivysaur · Caixa 01 → Equipe 02
`01` Confirmar
`02` Cancelar

JOGADOR [cita confirmação]: 01
BOT:
✓ *𝗣𝗢𝗞É𝗠𝗢𝗡 𝗥𝗘𝗧𝗜𝗥𝗔𝗗𝗢*
◇ Ivysaur · Equipe 02
　　　　〔 `02 / 06` 〕

JOGADOR: /depositar
BOT:
↓ *𝗗𝗘𝗣𝗢𝗦𝗜𝗧𝗔𝗥 𝗣𝗢𝗞É𝗠𝗢𝗡*
◇ Equipe ● `02 / 06`
[Ler mais]
`01` Bulbasaur · Nv. 08
`02` Ivysaur · Nv. 05
> _Responda citando esta mensagem._

JOGADOR [cita menu]: 01
BOT:
↓ *𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢*
◇ Bulbasaur · Equipe 01 → Caixa 01 / Vaga 01
`01` Confirmar
`02` Cancelar

JOGADOR [cita confirmação]: 01
BOT:
✓ *𝗣𝗢𝗞É𝗠𝗢𝗡 𝗔𝗥𝗠𝗔𝗭𝗘𝗡𝗔𝗗𝗢*
◇ Bulbasaur · Caixa 01 / Vaga 01
　　　　〔 `EQUIPE 01 / 06` 〕

JOGADOR: /organizar
BOT:
↻ *𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗥 𝗖𝗔𝗜𝗫𝗔𝗦*
▣ Bulbasaur · Caixa 01 / Vaga 01
[Ler mais]
`01` Escolher Bulbasaur
> _Responda citando esta mensagem._

JOGADOR [cita menu]: 01
BOT:
↻ *𝗡𝗢𝗩𝗢 𝗗𝗘𝗦𝗧𝗜𝗡𝗢*
◇ Bulbasaur · Caixa 01 / Vaga 01
`2/5` · Exemplo: Caixa 02 / Vaga 05

JOGADOR [cita prompt]: 2/5
BOT:
↻ *𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗥 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔ÇÃ𝗢*
◇ Bulbasaur · Caixa 01/01 → Caixa 02/05
`01` Confirmar
`02` Cancelar

JOGADOR [cita confirmação]: 01
BOT:
✓ *𝗖𝗔𝗜𝗫𝗔 𝗢𝗥𝗚𝗔𝗡𝗜𝗭𝗔𝗗𝗔*
▣ Bulbasaur · Caixa 02 / Vaga 05

JOGADOR: /caixas
BOT:
▣ *𝗖𝗔𝗜𝗫𝗔𝗦*
▣ Caixa 02 ● `01 / 30`
◇ Bulbasaur · Vaga `05`
```

## Revisão necessária
Este script é uma PROPOSTA de apresentação. Os resultados funcionais foram testados e observados (44/44), porém o texto não foi escrito pelo renderer atual. O comportamento de bloquear /depositar imediatamente com equipe unitária exige mudar a conversa atual (que oferece seleção e confirmação); não declarar implementado. Validar os exemplos em Android, iOS, WhatsApp Web, cotas de caption, acessibilidade de combining U+031D, referências citadas de mensagens e características de cada comando. Não alterar o bot real sem gate/consentimento.