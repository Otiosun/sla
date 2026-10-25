# Exploração Individual V1.3 — sorteio de recursos por área (Draft)

**Escopo desta entrega:** contrato de sorteio **puro**, sem integração com World/Expedition/Inventory, baseado nas decisões do baseline. Nenhum recurso foi concedido; nenhuma ação foi lançada no bot.

## Regras preservadas

- Procurar recursos custa **60 minutos internos** na expedição, debitados pelo futuro orquestrador transacional, nunca neste módulo.
- Cada tentativa executa **uma única rolagem** inteira em `[0, 9999]`; resultado sem achado não rerrola.
- A tabela ilustrativa inicial por área é: nada 75%, Poké Ball×1 15%, Potion×1 7%, Poké Ball×2 2%, Potion×2 1%.
- Expectativa matemática para essa tabela: 0,19 Poké Ball, 0,09 Potion, ₽65 em mercadorias por busca (usando ₽200 e ₽300 como valores de comparação, não como pagamento).
- **Os pesos por área não foram aprovados para uso no catálogo ativo.** Os testes usam a tabela inicial como fixture, mas o runtime só poderá aceitar catálogo explicitamente aprovado.
- Nenhum crafting, dinheiro automático, materiais sem função, recompensa dupla ou item que não conste do catálogo canônico ativo.

## Segurança dos inputs

`prepareExpeditionResourceTable` exige release id e área id iguais ao cursor World da sessão. Rejeita IDs de item que não estejam no conjunto validado pelo provedor, entradas repetidas, porcentagens negativas/fracionárias, quantidade inválida e tabela cuja soma difira de 10.000 basis points. Um `null` indica encontrar nada.

O resultado do sorteio é **apenas uma proposta**. Para torná-la jogável ainda precisamos:
1. Buscar a tabela aprovada por área, release, horário e condições mecânicas reais no PostgreSQL, sob o mesmo contexto da expedição.
2. Reservar ação válida, debitar 60 minutos, persistir recibo e aplicar inventário canônico na **mesma transação**. Idempotência deve evitar segunda rolagem e segunda concessão depois de retry, falha de outbox ou reinício.
3. Negar em área sem tabela/itens autorizados, fora das 12h, após blackout ou com combate incompatível.
4. Testar concorrência de duas mensagens, rollback após grant, falta de item cadastrado, crédito máximo BIGINT e tabela/versão alteradas.
5. Não ativar `/explorar recursos` sem integração V1.1–V1.7, UAT e aprovação.

**STATUS: política de probabilidades e validação V1.3 em Draft; não existe recurso jogável.**


## Ledger canônico atômico — prova de integração Draft (25/10)

`economyRepositoryForClient(client)` reutiliza o `PostgresEconomyTransaction` existente com a **mesma conexão** de `PostgresExpeditionFirstAction`. A suíte PostgreSQL `tests/db/expedition-first-action-atomic.integration.test.ts` cria um item sintético/legítimo em release publicada e exercita `EconomyService.addItem` dentro de um efeito **apenas de prova**:
- custo interno exatamente 60 minutos na fixture;
- 1 entrada de `inventory_ledger` e +1 `inventory_balances` sob recibo idempotente;
- retransmissão não grava outro item/ledger;
- falha após `addItem` desfaz inventário, ledger, cota, tempo e recibo em rollback único;
- `BigInt` da Economy é convertido para strings no recibo JSON, sem coerção insegura.

**Não é a busca de recursos jogável.** Não existe ainda provedor de tabela de loot por área publicado no banco e validado sob lock; esta suíte injeta um item sintético explicitamente. O orquestrador V1.3 somente poderá escolher recompensa de tabela autorada PUBLISHED, aplicar `prepareExpeditionResourceTable` + `drawExpeditionResourceOutcome` sob World/release autorizados e então usar este mesmo ledger canônico. Não aceitar itemId, quantidade, probabilidade ou roll fornecidos pelo usuário. Não habilitar rotas WhatsApp até essa fonte existir e passar integração/UAT.
