# Pokémon Beyond — Gestão Pokémon: diário da simulação de um treinador
Data: 27/10/2026 | Teste dedicado: **31/31 PASS, 0 BUG**
Execução com transcript: https://github.com/Otiosun/sla/actions/runs/40571287218
Código reproduzível: db/proofs/whatsapp_simulator_pokemon_management_journey_uat.ts
PRs Draft: Backend #260, Hub #126. Não houve merge nem acesso ao jogo real.

## Método
Duas contas sintéticas habilitadas pelo mecanismo oficial UatBootstrapService em PostgreSQL 18.6 descartável. As mensagens atravessaram adaptador simulado WhatsApp, roteamento operacional, inbox/outbox e serviços de jogo reais. A cada comando, o teste registrou respostas do bot e consultou tabelas persistidas. Equipe/Box também foi manipulada pelo mesmo serviço canônico que atende a interface.

**Nota de fidelidade:** Eco da Jornada e Pedra da Jornada são EXCLUSIVOS da fixture de UAT. A forma de destino foi escolhida da linha evolutiva legítima (Bulbasaur -> Ivysaur), porém evolução por essa pedra não é regra publicada. É uma condição artificial para comprovar saldo, consumo, idempotência, diálogo e atualização real dos dados, sem tocar no catálogo ou jogadores de produção.

## Diário observado — comandos e consequências

1. Cadastro mecânico sintético de A e B aprovado em ambiente isolado: ACTIVE, área Vila dos Arrozais, starter.
2. A envia /perfil: UAT Trainer, nível 1, status ACTIVE.
3. A envia /equipe: Bulbasaur Nv. 5, slot 1.
4. A envia /pokemon #1: ficha detalha HP, Nature Bold, Ability Overgrow, IVs, Growl e Tackle.
5. A envia /golpes: SEM PENDÊNCIAS.
6. O teste gera no banco uma escolha genuína de movimento como recompensa; /golpes mostra Eco da Jornada e opções de substituir/ignorar.
7. A envia /aprender 1 9: erro amigável, opção permanece PENDING.
8. A envia /aprender 1 1: bot confirma Growl -> Eco da Jornada; banco confirma choice RESOLVED e substituição exata do slot.
9. /golpes volta a mostrar SEM PENDÊNCIAS.
10. Simula-se segunda recompensa do mesmo golpe. /golpes avisa que Bulbasaur já conhece Eco da Jornada e NÃO deve substituir outro movimento.
11. A usa /aprender 1 pular: choice SKIPPED; golpe já aprendido permanece.
12. A consulta /evolucao #1: nível 16 automático para Ivysaur, além da opção sintética Pedra da Jornada x2.
13. Consulta cruzada de B às opções de A retorna lista vazia: isolamento de propriedade mantido.
14. A tenta /evoluir #1 1 (nível): bot informa que evoluções de nível são automáticas; forma não muda.
15. B consulta /evolucao #1: Pedra da Jornada x0.
16. B tenta /evoluir #1 2: bot informa que não possui a pedra, sem mudança.
17. A envia /evoluir #1 2: bot anuncia Bulbasaur -> Ivysaur; DB confirma nova forma, saldo sintético 2 -> 1.
18. Repete-se o mesmo ID de mensagem: nenhuma cobrança adicional (saldo fica 1).
19. A abre /pokemon #1 novamente: Ivysaur, HP recalculado, golpe aprendido preservado.
20. A usa /inventario: Pedra da Jornada x1.
21. Tentativa de retirar último membro ativo para Box vazia é negada, sem mutação.
22. B tenta mover Pokémon de A: NOT_FOUND e nenhuma escrita indevida.
23. Movimentação de Pokémon da Box para slot 1 ocupado: troca atômica, um Pokémon no time e um na Box.
24. A usa /pc fora do Centro: bot orienta usar /centropokemon.
25. A narra chegada com quatro frases de roleplay: mensagem livre processada.
26. A usa /centropokemon: recebe ambientação do Centro e fala da Enfermeira Hana.
27. A usa /pc: sistema CONECTADO, Equipe 01/06, Caixa 01 01/30.
28. A usa /caixas: Ivysaur Nv. 5 exibido na Caixa 01.
29. A usa /depositar: bot oferece seleção e avisa que um Pokémon precisa permanecer na equipe.

O contador exato do runner registra 31 verificações (a lista narrativa acima agrupa alguns checks), 31 aprovadas e 0 falhas. Logs etiquetados stage2.player.whatsapp, stage2.player.step e stage2.player.complete.

## Amostra literal das respostas reais do bot
- /aprender 1 1: “Bulbasaur aprendeu Eco da Jornada.”; exibe Growl -> Eco da Jornada.
- /aprender 1 pular: “Os movimentos atuais foram preservados.”
- /evoluir #1 1: “Evoluções por nível são automáticas e não precisam de confirmação.”
- /evoluir #1 2 (B sem item): “Você não possui Pedra da Jornada para essa evolução.”
- /evoluir #1 2 (A): “Bulbasaur evoluiu para Ivysaur.”
- /pc fora do centro: “Entre no Centro Pokémon com /centropokemon antes de usar esse comando.”
- /depositar: “Ao menos um Pokémon deve permanecer na equipe.”

## Problema real independente descoberto: cadastro UAT legado
Execução separada: https://github.com/Otiosun/sla/actions/runs/40569028116
O antigo roteiro multiator PvP/PvE registrou 12 falhas: em três submissões de cadastro não apareceu notificação de aprovação; dois jogadores ficaram NEW, sem Pokémon inicial, e os passos de PvP/PvE falharam em cascata. A causa ainda NÃO foi corrigida. Para não bloquear o teste de Pokémon, o cenário dedicado habilitou dois atores sintéticos pelo bootstrap oficial e não fingiu que a recepção havia funcionado.

## Limites e próximos trabalhos
- Isto comprova a experiência WhatsApp simulada e o serviço real do PC com banco descartável; NÃO comprova navegador Hub autenticado em staging, nem WhatsApp real.
- Fluxos interativos completos de depositar, retirar e organizar dentro da conversa ainda precisam ser percorridos até a confirmação e verificação de cada snapshot.
- Corrigir/atualizar a simulação antiga de cadastro e repetir o jogo completo sem bootstrap.
- Cobrir falha de transporte, concorrência batalha/Box, ADM real com reconciliação após recarga e evolução ramificada com gatilho ambíguo.
- Preservar design de front existente; não publicar Etapa 2 nem mesclar PRs sem autorização.
