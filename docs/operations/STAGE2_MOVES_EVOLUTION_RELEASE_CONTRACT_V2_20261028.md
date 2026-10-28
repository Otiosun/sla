# Pokémon Beyond — Regras fechadas da gestão Pokémon (candidato V2)

**Data:** 2026-10-28. **Status:** implementações sob PR Draft #260. Nenhum deploy, merge ou migração em jogadores reais foi realizado.

## 1. Autoridade do catálogo — decisão

Pokémon Beyond usa um **catálogo próprio, versionado, imutável após publicação**. O importador consome **PokéAPI v2** como fonte técnica de referência, na versão de jogo explicitamente selecionada por forma. Para o lote atualmente publicado de 39 espécies, o baseline unificado é **Ultra Sun/Ultra Moon**: todas têm registros de aprendizado nesta geração, evitando misturas silenciosas de métodos de versões diferentes. Qualquer exceção futura exige registro explícito. Não inventar golpes só porque a Pokédex nacional tem a espécie.

Para o lote de **39 formas ativas observadas em uma release PUBLISHED descartável**, a referência é \`docs/catalog/pokemon-beyond-move-sources.json\`. A importação completa para este recorte foi comprovada em CI: **39/39 espécies obtidas, 2.373 registros de aprendizado, 388 movimentos distintos, 90 TMs mapeadas**. Cada recurso preserva o hash de origem. O relatório de comparação mostrou **apenas oito revisões de movimento publicadas** e **2.457 ocorrências de diferenças de cobertura**, em grande parte as mesmas definições ausentes repetidas por espécie.

O builder \`scripts/catalog/build-versioned-move-proposal.ts\` não publica nem concede nada. Além de classificar **LEVEL, EVOLUTION, MACHINE, TUTOR, EGG**, prepara definições de movimento com tipo, PP, poder, precisão e revisão de efeitos. **Nenhum golpe com efeitos não implementados pode ser ligado silenciosamente à mecânica de dano básico.** A prova de conteúdo em \`pokemon-catalog-source-census.yml\` produz artefatos; \`db/proofs/stage2_release_publication_audit.ts --strict --proposal ...\` é o gate de publicação. O seed legado de Vine Whip nível 7 não vira uma tabela oficial apenas por alterar o nome da geração.

### Métodos de aprendizado e jogador

| Método | Condição | Custo | UX |
| --- | --- | --- | --- |
| LEVEL | Subir ao nível previsto na release fixada | Nenhum | Slot livre → aprende, quatro golpes → escolha persistente em /golpes |
| EVOLUTION | Entrar na forma que tem golpe de evolução | Nenhum | Mesmo comportamento de slots/pendência, inclusive correção histórica |
| TM/MACHINE | Ter TM real na mochila + compatibilidade da forma na release + movimento ativo | 1 TM por sucesso | /tms #N → /ensinar #N OPÇÃO [SLOT] |
| REMINDER | Movimento da forma atual já alcançado, oferta antiga pendente, ou golpe registrado na evolução/histórico prévio | Gratuito, apenas em Centro Pokémon | /centropokemon → /reaprender #N [OPÇÃO [SLOT]] |
| TUTOR/EGG/EVENT | Não confundir com LEVEL; somente quando fonte/mecânica própria estiver publicada | Regra explícita | Não anunciar recompensas hipotéticas como disponíveis |

- O máximo é **quatro golpes**. Se não houver slot, é obrigatória a identificação de 1 a 4. Sem slot livre/identificado não há gasto de TM.
- Uma TM só é consumida **depois** da validação de item compatível, saldo, golpe desconhecido, Pokémon próprio, não estar em batalha e slot correto. Todos os efeitos/ledger/histórico acontecem na mesma transação PostgreSQL. Repetição de mensagem não desconta duas TMs, nem reaprende duas vezes.
- Um golpe antigo recusado nunca é restaurado automaticamente; o treinador pode voluntariamente reaprendê-lo no Centro se o histórico/catálogo o permitir. Movimentos de uma forma pré-evolutiva só se elegíveis antes do nível em que deixou de ser aquela forma.
- Golpes de uma geração diferente não são aceitos sob o nome de um golpe da versão ativa. Exceções por forma são manifestas, revisáveis e versionadas.
- A origem de TM no MVP é **compra em Poké Mart quando houver oferta publicada**. Quests e drops devem conceder por serviços reais e constar do catálogo, não por narrativa livre.

## 2. Evolução — inclusive jogadores legados

- LEVEL automático em cada nível atravessado, inclusive quando ganha vários níveis de uma vez. Sem pedra ou solicitação manual.
- ITEM: item real, catálogo compatível, consumo atômico de uma unidade e atualização de forma; não cobrar em falha.
- CONDITION: flag elegível, auditável e verificada pelo servidor. Regras indistinguíveis ficam bloqueadas (não escolher aleatoriamente).
- A evolução mantém ID da criatura, proprietário, IVs, natureza, nível, XP, movimentos conhecidos, PP ajustados conforme mecânica e histórico; a nova forma recalcula HP, atributos e habilidade.
- Movimento de evolução é processado na forma nova. Se lotado, cria-se uma escolha pendente.
- **Recuperação atrasada:** \`/evolucao #N\` identifica que um Pokémon já passou do nível; \`/regularizar #N\` aciona uma evolução LEVEL revalidada na transação, sem XP artificial ou item, inclusive nível 100. No segundo pedido não haverá segunda evolução. Regras em conflito ou requisitos incompletos ficam bloqueados.
- A auditoria de histórico em \`db/proofs/stage2_overdue_level_reconciliation.ts\` opera em **dry-run por padrão e somente em PostgreSQL local descartável**. No deploy, a equipe precisa aplicar um plano aprovado de correção em lote ou orientar jogadores pelo comando; NENHUM banco real foi corrigido nesta sessão.

## 3. Itens — contratos de obtenção

- Loja é uma fonte concreta. O menu não usa mais os 16 itens estáticos como autorização: só mostra ofertas \`PUBLISHED\` da release \`ACTIVE\`, os preços verdadeiros, quantidades unitárias e nomes reais. Também suporta itens \`TM\` e \`EVOLUTION\` que sejam realmente publicados. Pedido é revisto antes da cobrança.
- Mochila e saldos só mudam por compra, concessão real de recompensa verificada, uso ou evolução registrados no ledger. Item de teste e pedra fictícia do UAT não são canônicos.
- Uma release não pode apresentar evolução por item sem meio de obtenção comprovado. Não há gasto em menu vencido, tentativa inválida, mensagem duplicada, Pokémon de outra conta, falta de saldo ou batalha ativa.

## 4. Jogadores iniciantes e avançados

**Iniciante:**
\`/pokemon #1\` mostra XP restante e links para \`/aprendizados #1\`, \`/tms #1\`, \`/evolucao #1\`. Em \`/golpes\` responde qual slot substituir ou \`pular\`; em \`/centropokemon\` usa \`/reaprender #1\` para movimentos antigos.

**Avançado:** pode consultar o learnset de sua release, usar números e slots explícitos, corrigir evolução atrasada sem precisar ganhar XP, não pode ensinar movimento incompatível, usar item de outro jogador, duplicar gasto ou escolher forma ambígua. O banco relê estado autoritativo na hora da mutação.

## 5. Homologação antes de liberação

- Typecheck, testes unitários e de DB do último commit, não de SHAs históricos.
- UAT em Postgres local, cobrindo TM compatível com duas unidades, aquisição, item 2→1, replay 1→1, relembrar, evolução atrasada inclusive Lv100, e nenhuma mutação em caso de falha.
- Fonte fixada de **todas** as formas ativas e diffs revisados; se faltarem movimentos, bloquear publicação ou manter a release anterior (não fingir cobertura).
- Hub autenticado, WhatsApp real, cliente mobile, ADM auditável, recuperação de rede, batalhas e concorrência validados.
- Merge/deploy/banco real somente após autorização explícita. O PR Draft não é jogador ativo.

### Fontes técnicas para o catálogo

- https://pokeapi.co/docs/v2
- https://pokemondb.net/pokedex/pidgey/moves/9
- https://pokemondb.net/scarlet-violet/unobtainable
