# Exploração V1.4 — admissão geográfica de serviços (Draft)

`inspectAutonomousFacilityAction` é um **pré-check puro** para sessões de expedição ACTIVE. A regra canônica da Jornada permanece intacta: o fluxo habitual de Centro/PokéMart pode continuar a exigir visita/cena, inclusive 50 palavras quando aplicável.

## Contratos

- **Centro Pokémon:** disponibilidade via `WorldLocationView.facilities`, mesmo jogador/área/release pinada, expedição ativa, ausência de batalha incompatível e **30 minutos internos disponíveis**.
- **PokéMart:** mesma checagem geográfica, sem custo interno relevante de tempo para a compra, mas a economia/balanço canônicos continuam obrigatórios; **não** conceder itens ou dinheiro diretamente.
- PREPARING, ENDED, BLACKOUT, catálogo/release inconsistente, local de outro jogador, área desativada, falta de instalação ou batalha em andamento: negar sem nenhum efeito.
- O valor retornado é apenas `actionMinutes`. Não existe UI ativada, healing feito, visita criada, venda executada, slot debitado, spawn disparado ou recibo criado.

## Integração antes de jogar

1. O orquestrador deve garantir conta ACTIVE + cadastro COMPLETE, ter um `ExpeditionSnapshot` canônico e leitura `WorldLocationView` correspondente, sob lock compartilhado.
2. Revalidar transacionalmente `facilities`, `contentReleaseId`, cursor de World, minutos disponíveis e estado de batalha, não confiar na prévia.
3. Encaminhar HEAL para o serviço existente de cura canônica, SHOP para a economia canônica. Novo contexto de expedição substitui **apenas nessa modalidade** o requisito narrativo da Jornada, sem modificá-lo globalmente.
4. Cobrar 30 minutos de cura dentro da mesma transação e mesmo recibo de idempotência, evitando cura parcial + relógio perdido em rollback.
5. Para SHOP, não inventar novos itens nem preços; sempre debitar carteira e entregar estoque com ledger canônico e replay seguro.
6. Testar desincronização, loja sem catálogo ativo, remédios em combate, ausência de tempo, concorrência e recuperação após reinício.
7. Não habilitar o comando autônomo até revisão e UAT da integração completa.

**STATUS:** elegibilidade de serviço em Draft, não expedição jogável.
