# Pokémon Beyond — Etapa 2 | Contrato de jogabilidade e buracos de conteúdo

**28/10/2026 · Estado: DRAFT, não aprovado para produção.** Este é um checklist verificável do jogo, não uma declaração de que a migração/catálogo já foi publicada.

## Problemas observados, com fonte

1. **Origem dos golpes:** o seed \`db/seeds/phase4_vertical_slice.ts\` lista 9 espécies, 8 movimentos, poucas entradas START/LEVEL e só três evoluções LV16. Não equivale a uma Pokédex completa. Ex.: Bulbasaur → Vine Whip Lv7 nesse seed, mas Scarlet/Violet lista Lv3. Não misturar tabelas e regras de versões.
2. **Aquisição de itens:** o render estático de \`src/modules/world-services/mart-catalog.ts\` mostra 16 produtos. O seed \`db/seeds/phase6_economy_slice.ts\` instala apenas as ofertas shop.poke-ball e shop.potion nesse estágio. Releases posteriores podem ter mais ofertas; é necessário conferir o PUBLISHED ativo. Pedra da Jornada e Eco da Jornada são dados sintéticos de UAT e não podem ser apresentados como itens distribuídos. Não há rota de loot/drop/quest/TM geral homologada aqui.
3. **Evolução atrasada:** a progressão por nível verifica regras enquanto atravessa níveis. Jogadores que estão acima da exigência, mas ficaram sem evoluir, precisam de reconciliação mesmo no nível 100. Não fazer SQL UPDATE manual, nem forçar XP extra para curar o problema.
4. **Golpes antigos:** ausência de movimento equipado não comprova falha; o treinador pode ter recusado ou trocado. Histórico e escolhas pendentes precisam ser examinados antes de oferecer recuperação.
5. **Poké Mart confiável:** toda oferta exibida tem de existir ativa no catálogo publicado, com preço e quantidade iguais. Nunca criar um botão que falhará por catálogo inexistente.

## Leis do motor

- O banco, a release de conteúdo fixada ao jogador e as regras publicadas são a autoridade; mensagens do WhatsApp e o Hub são apenas interfaces.
- Nível Pokémon 1–100; curva CUBIC_DELTA_V1; recompensa PvE v1 apenas ao vencedor ativo ao final. Progressão do treinador é separada. XP duplicada e consumo duplicado devem ser rejeitados por idempotência.
- Golpes novos por LEVEL seguem o learnset da forma no release fixado. Slots 1–4; aprende automaticamente se livre; quatro ocupados → PENDING. Golpe já conhecido não duplica. Uma recusa explícita não é reoferecida como se fosse bug.
- Evolução LEVEL automática no crossing; ITEM manual consome 1 em transação; CONDITION manual só com flag elegível. Caminhos indistinguíveis bloqueados, nunca selecionados arbitrariamente.
- Na evolução por nível: aprender golpes do nível na forma anterior, evoluir, aprender golpes da forma nova no mesmo nível; recalcular atributos, HP e habilidade sem perder IVs, natureza, treinador, slots ou histórico.
- TMs/tutores/reaprendizado não passam como LEVEL. Requerem implementação e fontes de itens próprias com gasto atômico, compatibilidade por espécie e histórico. Não anunciar como disponível antes disso.
- Nenhum catálogo pode ser publicado com rota de evolução por item sem fonte verificável para obtê-lo. Não presumir loot ou eventos se não houver mecanismo real.

## Catálogo de referência e importação

**Base sugerida para revisão:** PokéAPI \`version_group = scarlet-violet\` apenas para espécies presentes nesse grupo. Para espécie/forma ausente, exigir seleção explícita de outra versão aprovada pela equipe; nunca misturar silenciosamente. Conferência secundária manual com Bulbapedia/Pokémon Database quando houver conflito.

O módulo \`versioned-learnset-source.ts\` valida o payload, filtra \`move_learn_method=level-up\`, separa \`LEVEL\` de \`machine/tutor\` e compara com o seed. **Não faz download nem publica conteúdo no banco.** Fontes: https://pokeapi.co/docs/v2 e https://pokemondb.net/pokedex/bulbasaur/moves/9

## Como deveria ser para o iniciante

\`\`\`text
JOGADOR: /pokemon #1

BOT:
◈ *POKÉMON*
#1 · Bulbasaur
Nv. 05 · HP [valores reais]
XP [acumulado / necessário] · faltam [valor real]
/aprendizados #1 · O que aprende por nível
/golpes · Escolhas pendentes
/evolucao #1 · Evoluções e requisitos

JOGADOR: /aprendizados #1

BOT:
✦ *𝗔𝗣𝗥𝗘𝗡𝗗𝗜𝗭𝗔𝗗𝗢𝗦*
◇ Bulbasaur · Nv. 05
_Seu catálogo de movimentos_
◇ PRÓXIMOS NÍVEIS
Nv. 07 · Vine Whip    (seed atual de teste; não é Scarlet/Violet)
_Quando houver 4 golpes, use /golpes para escolher._
\`\`\`

Não deixar o jogador procurar um comando inexistente para conseguir TMs. Orientar que somente métodos habilitados e fontes reais podem ser usados.

## Como deveria ser para o avançado com bug antigo

\`\`\`text
JOGADOR: /evolucao #1

BOT — CANDIDATO DE UX, AINDA NÃO IMPLEMENTADO:
△ *EVOLUÇÃO ATRASADA*
Seu Pokémon está acima do nível exigido. O sistema
identificou uma possível pendência histórica.
Não é necessário ganhar XP nem usar uma pedra.
A equipe verificará o histórico e a regra do catálogo.
Nenhum item, golpe ou Pokémon foi alterado.
\`\`\`

Ação do operador em staging: scanner read-only cruza \`pokemon_instances\`, release pinada, \`evolution_rules\`, stats, logs e claims; classifica \`ELIGIBLE_TO_REVIEW/NEEDS_STAT_REVIEW/AMBIGUOUS/NO_ELIGIBLE_RULE\`. Em \`ELIGIBLE_TO_REVIEW\`, compensação aprovada precisa ser **atômica, idempotente, auditada, com preview dry-run, before/after e rollback em caso de falha**; deve preservar nível, XP, moves, personalidade, propriedade e HP coerentes. Não executar no jogo ativo sem autorização e backup. Para movimentos antigos, verificar escolhas resolvidas/ignoradas, e **criar oferta pendente apenas para omissões comprovadas**, nunca substituir slots silenciosamente.

## Fontes de itens

- **Homologado estruturalmente:** compras via \`/pokemart\`, \`/comprar\`, inventário \`/inventario\` e venda \`/vender\` com saldos/ledger; a presença de ofertas específicas depende da release PUBLISHED.
- **Não tratar como homologado:** pedras evolutivas comerciais, TM, loot, missão, recompensa por NPC, drop em selvagens, troca entre jogadores. Precisam de fonte e teste específicos antes de anúncios.
- Todo item de evolução publicado deverá expor \`/evolucao #n\`: espécie destino, requisito, nome do item, saldo e rota de obtenção. Se a fonte não existir, bloqueie a publicação ou a opção; não indique compra impossível.

## Gates obrigatórios antes de liberar a Etapa 2

- Resultado verde de todas as jobs Stage2 no HEAD atual; o antigo 44/44 é de um SHA histórico e não valida o código posterior.
- Source manifest para **100% das formas ativas** da release-alvo, moves e respectivas revisões referenciadas presentes; conflitos externos revisados.
- Zero ofertas mostradas que não existam no catálogo ativo; zero evoluções por item sem fonte de obtenção real para jogador.
- Jornada sintética com jogador iniciante e avançado, comandos reais \`/aprendizados\`, \`/golpes\`, \`/aprender\`, \`/evolucao\`, \`/evoluir\`, compra, inventário, equipe, PC, Hub e ADM.
- Diagnóstico de Pokémon antigos em staging + aprovação e prova de um reparo nível 100 sem XP fictícia, efeito colateral ou duplicação.
- Browser Hub/ADM mobile e WhatsApp real; falha de rede, replay, concorrência, batalha ativa, multi-destino, permissões.
- **Nenhum merge, deploy, migração no banco real ou concessão manual como decorrência deste documento.**
