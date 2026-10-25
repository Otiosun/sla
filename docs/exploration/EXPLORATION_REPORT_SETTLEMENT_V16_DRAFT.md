# Exploração V1.6 — proposta de premiação e revisão do relatório (Draft)

Esta entrega introduz **somente política pura** de sorteio em `expedition-report-reward-policy.ts`. Não recebe texto do relatório, não grava aprovação administrativa, não concede dinheiro/itens/progressão, não cria outbox e **não habilita exploração**.

## Pré-condições canônicas

- `expeditionRequiresReport` só aceita expedição encerrada por `VOLUNTARY` ou `CLOCK`, com cota semanal já debitada.
- Cancelamento em PREPARING, expedição ainda ativa e `BLACKOUT` não podem gerar proposta de bônus. Blackout rende **₽0 de conclusão**.
- O relatório externo deve possuir ≥100 palavras e ser aprovado por administração autorizada; isso será aplicado na camada administrativa e seu ledger, não aqui.
- `REJECTED` retorna `null` e consome zero RNG; prêmio futuro exige aprovação `NORMAL` ou `HIGHLIGHT`.
- A staff escolhe apenas a modalidade de aprovação; não escolhe um prêmio específico nem informa o resultado do RNG.

## Premiação normal aprovada

Base fixa **₽300**, acrescida de **uma** rolagem em `[0, 99]`:

| Faixa de roll | Peso | Resultado |
|---|---:|---|
| 0–44 | 45% | +₽200 |
| 45–74 | 30% | Poké Ball ×1 |
| 75–89 | 15% | Potion ×1 |
| 90–99 | 10% | +50 progressão de treinador |

Expectativa: ₽390, 0,30 Ball, 0,15 Potion e 5 pontos de progressão por relatório normalmente aprovado. Não é XP de combate.

## Destaque

O destaque recebe **exatamente mais uma** rolagem independente em `[0,99]`:

| Faixa de roll | Peso | Resultado |
|---|---:|---|
| 0–59 | 60% | +₽100 |
| 60–84 | 25% | Poké Ball ×1 |
| 85–94 | 10% | Potion ×1 |
| 95–99 | 5% | +25 progressão |

É proibido transformar a modalidade em um dropdown de prêmio escolhido por ADM.

## Trabalho de integração antes de liberar V1.6

1. Persistir referência idempotente da expedição, relatório externo (não texto), ator/revisão ADM, status, modalidade e seed/RNG ou resultado congelado, sob lock transacional.
2. Aplicar carteira, estoque e progressão por serviços existentes com evento único e ledger financeiro/administrativo; sem duplicação após retry/outbox, dois admins, reset do bot ou falha a meio caminho.
3. Revisar o caso de relatório aprovado após expedição terminar e o efeito de reversão administrativa; itens/XP adquiridos durante campo permanecem legítimos em caso de rejeição.
4. Testar falha de persistência, concorrência, bloqueio ao jogador suspenso, quantidade BIGINT e mesmas probabilidades com RNG determinístico.
5. Exibir apenas total e recompensas humanas no Rotom, sem SHA, id da transação ou parâmetros internos.
6. Integrar 1.1–1.5 + 1.7, revisão de migration numerada após 0078, restauração comprovada e UAT real. Sem autorização de deploy, /explorar permanece fechado.

**STATUS:** somente políticas de bônus e elegibilidade codificadas e testáveis. Nenhum payout real.
