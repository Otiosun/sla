# Pokémon Beyond — Gestão Pokémon / WhatsApp V2 — limites e escolhas

**Data:** 28/10/2026. **Estado:** proposta de UX e correções Draft no backend. **Não é screenshot de WhatsApp, nem aprovação final, nem deploy.**

Fontes literais preservadas:
- `docs/ux/STAGE2_PLAYER_WHATSAPP_CONVERSATION_V1_20261028.md` (candidata anterior)
- `docs/ux/EXPLORATION_PLAYER_FLOW_UX_V4_APPROVED_20261026.md` (referência visual parcialmente aprovada, branch de Exploração)
- `docs/integration/FRONTEND_WHATSAPP_STYLE.md` (referência de formatação)
- `docs/operations/stage2-player-journey-uat-20261027.md` (44/44 apenas no checkpoint antigo)

## Regras aplicadas

- O topo mostra estado/resultado e identificação; [Ler mais] só nos painéis longos. Marcador editorial, jamais payload.
- Erros curtos, cancelamentos e confirmações permanecem visíveis sem dobra.
- Respostas numéricas para PC dependem de citação ao prompt atual; números soltos ou respostas a menus antigos não autorizam gastos nem alterações.
- `/depositar` com zero/um Pokémon não cria seleção nem prompt ativo; `/retirar` com seis Pokémon também não.
- `/organizar` em vaga ocupada não sugere troca: a operação atual é de mover para destino *livre*. Não prometer troca de vagas ocupadas sem serviço transacional próprio.
- `/evolucao` mostra destinos por catálogo. Se dois destinos têm o mesmo gatilho manual (mesmo item ou CONDITION), não oferece comando; `/evoluir` também bloqueia antes da mutação. A progressão já recusa múltiplas regras elegíveis.
- Evolução LEVEL é automática ao ganhar XP; nunca oferecer ação de nível manual.
- Saldos, formas e golpes só mudam depois de operação autoritativa, não por texto de Cena ou simulação.
- Não presumir que Bulbasaur -> Ivysaur por Pedra da Jornada exista no catálogo publicado: é fixture exclusivamente sintética.

## Amostras WhatsApp (texto literal; **não saída de produção**)

### Último membro

```text
JOGADOR: /depositar

BOT:
△ *𝗗𝗘𝗣Ó𝗦𝗜𝗧𝗢 𝗕𝗟𝗢𝗤𝗨𝗘𝗔𝗗𝗢*

> _O último Pokémon da equipe não pode ser guardado._

◇ *Ivysaur* · Equipe 01/06

↑ `/retirar` · Traga outro Pokémon primeiro
‹ `/pc` · Voltar ao terminal
```

### Equipe completa

```text
JOGADOR: /retirar

BOT:
△ *𝗘𝗤𝗨𝗜𝗣𝗘 𝗖𝗛𝗘𝗜𝗔*

> _Você já possui seis Pokémon ativos._

⚡ Equipe · `06 / 06`
Nenhuma retirada foi realizada.

↓ `/depositar` · Liberar uma posição
‹ `/pc` · Voltar ao terminal
```

### Vaga ocupada

```text
JOGADOR [cita "NOVO DESTINO"]: 1/6

BOT:
△ *𝗩𝗔𝗚𝗔 𝗢𝗖𝗨𝗣𝗔𝗗𝗔*

◇ *Geodude* já ocupa a Caixa 1 / Vaga 6.

Informe uma vaga livre. Nenhum Pokémon foi movido.
```

### Caminhos de evolução indistinguíveis (apenas fixture hipotética)

```text
JOGADOR: /evolucao #4

BOT:
✦ *EVOLUÇÃO*

#4 · *Pokémon da fixture* · Nv. 16

*1. Destino A*
  _Indisponível: vários destinos usam o mesmo gatilho._
  _A escolha de destino ainda não pode ser diferenciada com segurança._

*2. Destino B*
  _Indisponível: vários destinos usam o mesmo gatilho._
  _A escolha de destino ainda não pode ser diferenciada com segurança._

_Evoluções por nível acontecem automaticamente quando o requisito é atingido._

JOGADOR: /evoluir #4 1

BOT:
△ *EVOLUÇÃO BLOQUEADA*

Há mais de um destino para esse mesmo gatilho.
Nenhum item foi consumido.
```

## Estado de engenharia e verificação

Trabalho somente na branch Draft `feat/pokemon-management-stage2-20261027`:
- Novos testes: `tests/progression/whatsapp-evolution-ambiguity.test.ts` e `tests/world-services/pc-organize-ux.test.ts`.
- Testes de bloqueios de PC em `tests/world-services/whatsapp-handlers.test.ts`.
- Workflow isolado Stage2 atualizado para rodar os testes novos.
- UAT legada de 44/44 exige rerun no HEAD atual; checkpoints anteriores não certificam estas mudanças.

**Gates ainda abertos:** CI no HEAD final, catálogo PUBLISHED, staging isolado e navegador real Hub/ADM, WhatsApp Android/iOS/Web e acessibilidade, integração ponta a ponta web/API/PG, reconciliação de falha de rede/ADM, concorrência batalha/roster, e aprovação explícita. Não mesclar nem publicar como consequência deste documento.
