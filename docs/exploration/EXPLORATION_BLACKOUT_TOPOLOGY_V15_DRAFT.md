# Exploração V1.5 — resgate por topologia do World (Draft)

**Estado:** há um algoritmo puro de decisão, ainda sem ação de encerramento, deslocamento, cura ou cobrança no runtime.

`planExpeditionBlackoutRescue` recebe a release publicada/ACTIVE pinada, o cursor atual e uma topologia **já verificada** pelo servidor. Todos os nós devem vir do catálogo World canônico com status ativo, `explorationApproved` e `safePoint` aprovados. Cada conexão é dirigida e sua disponibilidade deve incorporar unlocks e condições reais do jogador.

- Se o jogador já estiver num ponto seguro autorizado, a localização permanece a mesma.
- Caso contrário, a decisão prefere o ponto seguro **alcançável** por menos conexões dirigidas. Empates são determinísticos por ID interno, nunca por preferência não autorada.
- Não atravessa conexões bloqueadas, regiões não aprovadas, áreas inativas ou arestas inexistentes.
- Sem destino alcançável, falha explicitamente e solicita suporte: **não teleporta automaticamente** à Vila dos Arrozais nem inventa conexão.
- O resultado contém apenas rota verificada e ID de área segura. Não altera World, saldo, XP, itens, HP, Pokédex ou cota.
- `BLACKOUT` continua a consumir a expedição e não dá prêmio de conclusão, conforme estado V1.1 e política V1.6.

## Integração pendente

O runtime de recuperação deve conferir time totalmente incapaz de lutar e bloquear combates/encontros ativos incompatíveis, carregar topologia/unlocks **dentro do mesmo lock transacional** da expedição e World, persistir encerramento + recuperação canônica + cursor + recibo idempotente de uma vez, e entregar resultado ao Rotom via outbox após commit.

**Não tratar a rota deste pré-check como autorização de teleporte.** WorldService e o plano de recuperações/visitas/restrições ainda precisam ser reconciliados. Validar não alteração de XP/capturas/itens já legítimos, replay de Baileys, blackout em meio a batalha, indisponibilidade de ponto seguro, múltiplos jogadores e rollback integral. Não publicar antes de UAT e backup restaurável.
