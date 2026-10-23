# Pokémon Beyond — Integração #240, diagnóstico local e critérios de cutover

**Estado:** PR draft #240; sem merge, instalação local, migração, reinício de PM2 nem alteração da sessão Baileys. **Controle de tarefas:** [checklist viva no Drive](https://docs.google.com/document/d/1Pxm0JPQ661Hbb6NPvLw78anbf75QBqS5VuWWr3Gqm3s/edit).

## Composição verificada

A branch `integration/command-moves-security-20261023` reúne mudanças de #228 (segurança), #235 (comandos), #238 (seleção de golpes) e #239 (aprendizagem/UX). As quatro têm a mesma base `3bec8388c1b1aa132b2fa8306a39b43f65ff31f8`. Foram combinados **29 arquivos distintos**; nenhum caminho duplicado. No commit inicial da composição `b9fda72053e90417a52659077caad341c64fa55f`, todos os **18 workflows** GitHub Actions terminaram com sucesso, inclusive **CI principal, Security Integrity, WhatsApp, World, Battle, Progression, Capture e Economy**.

**Isso é prova automatizada, não garantia de que o computador do operador executa o mesmo código.**

## Etapa 1 — Diagnóstico local estritamente de leitura

No Windows, em PowerShell, executar **somente quando estiver preparado para compartilhar o resultado sanitizado**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\operations\pokemon-command-readiness-readonly.ps1" -RepoPath "$env:USERPROFILE\Documents\meu-bot-rpg"
```

O arquivo está nesta branch da PR, portanto deve primeiro estar disponível no PC (por download manual ou cópia isolada). **Não realizar `git pull`, `git checkout` ou `git reset` para obter o script.** Execute a cópia baixada diretamente ou informe seu caminho ao comando acima.

O script apenas consulta:

- commit e branch da cópia Git;
- número de alterações locais, **sem imprimir nomes de arquivos**;
- se o daemon PM2 já está em execução; somente nesse caso consulta `pm2 jlist`, não o inicia;
- estado do processo e **presença/formato**, nunca o valor, de `PVE_TURN_WINDOW_TTL_MS` e `PVE_MAINTENANCE_BATCH_SIZE`.

**Não** acessa DB, login, sessões, arquivos `.env`, conteúdo de arquivos ou argumentos de execução para exibição. **Observação de privacidade:** `pm2 jlist` retorna ao processo PowerShell metadados completos, inclusive valores de ambiente potencialmente sensíveis; o script inspeciona somente os dois flags de PvE e **nunca imprime nem salva esses valores**. Não compartilhe a saída bruta de `pm2 jlist`. `GIT_OPTIONAL_LOCKS=0` impede atualizações opcionais de índice durante a leitura Git. O SHA da pasta do processo é informação insuficiente para provar qual bundle JavaScript já carregado o PM2 executa.

Os dois flags de PvE seguem o parser do runtime: se **ambos** estão ausentes, o motor de PvE não monta; se apenas um está ausente ou algum é inválido, a inicialização pode falhar. Ambos devem ser inteiros decimais positivos, sem zero à esquerda, e dentro do intervalo seguro de JavaScript. O script informa estados, não números.

## Etapa 2 — Garantias antes do cutover

1. Preservar quaisquer mudanças locais ou não commitadas; identificar a origem do build efetivamente em execução. **Nunca sobrescrever alterações do operador.**
2. Confirmar configuração real dos grupos GAME e as capacidades `world`, `player.basic`, `pve`, `pvp`; `encounter.support` continua exclusivo de narrador. A PR #235 evita sucesso enganoso de `/grupo jogo` em RECEPTION/STAFF/PVP/COMMUNITY.
3. Em PostgreSQL efêmero, executar os fluxos reais dos serviços de PvP/PvE, compra, pesca, replays, comandos duplicados e recuperação de restart; incluir casos de grupo legado e usuário novo. Testes com **handlers reais + portas sintéticas** passam, mas não substituem esse gate.
4. Validar o catálogo de golpes apontado pela `content_release_pointers.ACTIVE` do ambiente alvo usando apenas consulta autorizada read-only. O importador versionado da PokeAPI não prova qual release o PM2 usa.
5. Conferir backup **e restauração testada** num banco isolado antes de qualquer operação com efeito no banco de verdade. Definir rollback do código e da configuração.
6. Reexecutar CI e Security Proof no commit **exato** pretendido para release. Não aprovar por resultado de outro SHA.
7. Aplicar primeiro comandos/segurança/golpes e validar com operadores. O /explorar da PR #236 ainda **não está pronto** para jogadores.

## Dependências deliberadamente excluídas

**Premium PR #232:** contém migrações **0076–0078** e mudanças de `src/platform/progression/postgres-progression-repository.ts`, **mesmo arquivo alterado por #239**. A Premium adiciona multiplicador 2× e catálogo/regra de XP, enquanto #239 protege escolha de golpes. A fusão requer reconciliação por funções, contratos e testes de XP+golpes; **não substituir o arquivo inteiro por uma das duas versões**. Verificar migrações com o banco alvo antes de numerar qualquer outra. A exploração #236 mantém sua SQL em `db/drafts` e continua fora desta integração.

**Frontend/Hub:** a revisão visual está planejada em paralelo, mas não é pré-requisito para diagnosticar se comandos operacionais funcionam.

## Classificação dos resultados

- **PR com CI verde:** mudança testada em ambiente controlado.
- **Diagnóstico local coletado:** versão e condições do operador conhecidas (não equivale a deploy).
- **Staging/UAT real verde:** fluxo funcional homologado com serviços compostos e dados descartáveis.
- **Publicação local:** só depois dos gates, backup, rollback e autorização; nunca presumida.

Atualizar IDs **A05, A06, A07, B05, H02, H05, H06** no Drive a cada avanço comprovado.


## Resultado real do preflight Windows (23/10/2026 às 18h27, BRT)

**Recebido do usuário, coleta somente leitura:** branch local `main`, commit `667770e51ad28d48da43e852877ba05f1efcb41e`, **24 arquivos alterados ou novos** no diretório `C:\Users\natan\Documents\meu-bot-rpg`. O PM2 estava ativo, mas a ferramenta então usada não conseguiu interpretar o JSON. **Isso NÃO comprova que o PM2 esteja executando o mesmo commit da pasta.**

A API GitHub para o repositório remoto `Otiosun/sla` não localizou esse SHA: **não assumir que a `main` local e a `main` publicada sejam equivalentes**; pode haver commits só locais ou um histórico divergente. Nenhuma tentativa de checkout, reset, pull, merge, instalação ou reinício foi realizada.

**Bloqueio obrigatório:** proteger os 24 arquivos antes de qualquer aplicação, verificar histórico e origem por leituras locais, identificar o processo real. Nunca presumir que um PM2 “online” implica runtime atualizado ou configurado.

O primeiro diagnóstico do usuário relatou “PM2 em execução, mas lista JSON indisponível”. Isso pode ser falha da versão de parser do PowerShell 5.1, não prova desligamento do aplicativo. A versão inicial do script rastreado no GitHub foi encontrada **corrompida** (trecho truncado e bloco duplicado); foi substituída integralmente e conferida por leitura de volta. Use apenas a versão nova dessa branch, **não as cópias anteriores**. O parser revisado usa `System.Web.Script.Serialization.JavaScriptSerializer` sensível a maiúsculas/minúsculas, em vez do `ConvertFrom-Json` que pode falhar com nomes de variáveis duplicados em caixas diferentes. **Ainda não foi executado nem homologado em Windows 5.1 real.**

Se mesmo assim não for possível ler `pm2 jlist`, o script não imprime JSON bruto (que pode conter segredos) e orienta usar `pm2 status`, compartilhando somente nome do processo, status e tempo ativo. Nunca enviar a saída bruta de `pm2 jlist`, `pm2 env`, `pm2 show`, conteúdo de `.env` ou tokens.
