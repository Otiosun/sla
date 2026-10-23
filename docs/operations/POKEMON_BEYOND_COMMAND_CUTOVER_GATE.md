# Pokémon Beyond — gate de correção dos comandos (23/10/2026)

**Estado:** plano de validação, **não** autorização de publicação. PRs envolvidas: [#228](https://github.com/Otiosun/sla/pull/228), [#235](https://github.com/Otiosun/sla/pull/235), [#232](https://github.com/Otiosun/sla/pull/232) e [#236](https://github.com/Otiosun/sla/pull/236).

## 1. Prioridade e isolamento

Primeiro recuperar os comandos /desafiar, /aceitar, /spawn, /iniciarbatalha, /comprar e /pescar para papéis e condições legítimas. Exploração Individual /explorar, revisão futura do fluxo e frontend são etapas separadas, não pré-requisitos para corrigir comandos.

**Não** executar git pull, git reset --hard, git clean, git stash, pm2 restart, manipulações de .env/sessões WhatsApp, migrações ou escritas no banco de jogadores automaticamente. O computador local possui alterações não commitadas que precisam ser preservadas. GitHub **não é prova** do commit executado pelo PM2.

## 2. Pré-flight somente leitura, no computador real quando autorizado

No diretório do bot, coletar sem compartilhar credenciais:

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git remote -v
pm2 status
```

Conferir o processo efetivo e sua revisão sem imprimir variáveis secretas. Se houver mudanças locais, preservar todas antes de integrar; preferir worktree isolado ou staging separado. Não sobrescrever a árvore ativa. Coletar nomes e presença, não valores, das chaves de configuração requeridas.

- PvE/PvP só montam quando loadPveBattleRuntimeConfig recebe PVE_TURN_WINDOW_TTL_MS e PVE_MAINTENANCE_BATCH_SIZE, ambos inteiros positivos; falta de ambos implica **motor desligado**, não bug de /desafiar.
- /spawn e /pescar dependem de encounterRngConfig para geração de encontros. Nunca alterar chave RNG/criptografia como atalho.
- Grupo configurado com /grupo jogo precisa das capabilities world, player.basic, pve e pvp; a atualização não é retroativa sem reconfiguração administrativa explícita.
- /spawn e /iniciarbatalha continuam exigindo encounter.support, mesmo em grupo de jogo. Não dar esta capability a jogadores para mascarar erros.

## 3. Matriz de aceitação — dados sintéticos e banco isolado

| Papel e comando | Condições legítimas | Resultado esperado |
|---|---|---|
| Jogador /desafiar @alvo | grupo GAME com pvp, ambos aptos, menção real, mesmo local | desafio criado uma vez |
| Alvo /aceitar | convite pendente do destinatário, pvp, personagem preparado | batalha PvP iniciada uma vez |
| Jogador /spawn | sem encounter.support | recusado sem gerar encontro |
| Narrador /spawn @treinador | pve, encounter.support, área e party compatíveis | encontro apresentado uma vez |
| Jogador /iniciarbatalha | sem encounter.support | recusado sem batalha de terceiro |
| Narrador /iniciarbatalha @treinador | encontro ativo em estado permitido | transição canônica de batalha |
| Jogador /comprar | grupo world, visita vigente ao /pokemart | catálogo e fluxo de compra legítimo |
| Jogador /pescar | grupo world, pesca configurada, sem batalha, limite disponível | sorteio canônico e 1 tentativa contabilizada |
| Jogador /pescar | área inválida, limite diário ou encontro ativo | mensagem contextual sem efeitos indevidos |
| Grupo desconhecido | qualquer comando protegido | acesso negado e sem efeitos |
| Cadastro incompleto | comando de preparo obrigatório | negado com orientação |
| Replays | ações mutáveis e mensagens repetidas | não duplicar encontros, itens ou pagamentos |

**Observações:** /comprar já exige visita ao PokéMart, cuja admissão na Jornada pode exigir cena narrativa. Não eliminar globalmente essa regra: a Exploração Individual criará ingresso próprio depois. /pescar tem cota diária própria, distinta das 3 expedições semanais.

## 4. Testes, integração e publicação

1. Revisar #228 para sharp@0.35.5: esta PR já passou CI, WhatsApp e Security. Incorporar separadamente de maneira controlada; não recriar lockfile manualmente.
2. Executar pnpm install --frozen-lockfile, lint/format/typecheck, unitários, PostgreSQL efêmero, WhatsApp, World, Encounter, Battle, Economy e Security.
3. Em staging sem pessoas reais, testar /grupo jogo, capabilities e casos positivos e negativos da matriz. Grupos reais não são alterados até cutover autorizado.
4. Verificar flags e estado **no processo de runtime realmente iniciado**, não somente no GitHub ou em outro .env.
5. Com staging aprovado, comparar modificações locais, preparar backup com acesso restrito, rollback verificável e janela de manutenção; exigir aceite explícito antes do cutover. Não compartilhar sessão Baileys, tokens, DB URIs ou dados privados.

## 5. Limites da conclusão

Testes de roteador com handlers simulados verificam admissão/permissões, **não** transações reais de compra, pesca e PvP. CI verde verifica a branch, **não** a árvore local do PM2. Frontend e UX geral serão revisados após o gate de comandos e antes da publicação da Exploração Individual.

A PR #232 Premium reserva migrações 0076–0078: **não** criar outra migração com número igual na Exploração V1.1. O relógio e a máquina de estados da #236 são independentes do banco e ainda não constituem /explorar funcional.
