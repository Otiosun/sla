# Pokémon Beyond — Gate E / aplicação local (checkpoint, 19/10/2026)

> **NÃO É UMA ORDEM DE EXECUÇÃO.** Documento de preparação. O usuário hospeda o bot WhatsApp localmente e pediu aviso explícito antes de qualquer ação no próprio computador. Nenhuma etapa de aplicação local está autorizada ou foi executada por este documento.

## Estado verificável da preparação remota

- Bot em produção conhecido: `Otiosun/sla` branch `main` a partir de `3bec8388c1b1aa132b2fa8306a39b43f65ff31f8`; **não concluir que o computador local usa esse SHA**. Confirmar pessoalmente no checkpoint de implantação.
- [PR #228](https://github.com/Otiosun/sla/pull/228): somente dependências `sharp@0.35.5` (3 arquivos), criada a partir de `main`. A atualização de dependências NÃO está aplicada ao bot local.
- [PR #227](https://github.com/Otiosun/sla/pull/227): Core Premium + HTTP + XP2× + migrações 0063–0076, flags staging-only; **draft**. Histórico da antiga [PR #225](https://github.com/Otiosun/sla/pull/225) diverge em 331 commits e não deve ser mesclado cegamente.
- Web [PR #107](https://github.com/Otiosun/pokemon-hub-web/pull/107): interface/carrinho de prévia. O proxy da API Premium está *fail-closed* e não deve ser apontado para API live.
- A execução bem-sucedida de CI cobre PostgreSQL **descartável** em runner remoto; **não cobre** o estado atual do computador local, a sessão Baileys ou o banco dos jogadores.

## Auditoria das migrações — efeitos além do Premium

| Arquivos | Efeito observado | Risco/decisão de release |
| --- | --- | --- |
| `0063` | Cria recibos para ajustes administrativos de XP Pokémon | Tabela não necessária para o 2XP comercial, mas exigida pela sequência do migrador |
| `0064–0071` | Cria e amplia tabelas de aparições competitivas, atividade de grupo, prêmios, proteção contra palpites e incenso | São schema e índices de **outra feature**. `0066` marca grupos como desabilitados por padrão; criar tabela não ativa um worker. Exigir revisão de compatibilidade |
| `0072` | Registra capability `player.identity.change` (risco 4), insere a capability no papel `OWNER_SECURITY_ADMIN` e **remove essa capability dos demais papéis** | **Não é apenas schema. Altera permissões administrativas existentes**. Precisa snapshot da matriz de acessos, aceite de segurança e rollback por restauração/compensação auditada. Comentário interno usa número antigo, mas o arquivo é `0072` |
| `0073` | Entitlements e histórico de concessões | Comentário interno cita numeração antiga. Não renumerar nem editar a migração já auditada só para corrigir comentário |
| `0074` | Catálogo, pedidos, itens, pagamentos e entregas | Estruturas comerciais com sequência/ledger, exige proteção de dados e backup |
| `0075` | Cadastra `XP_2X` e SKU `2XP` por R$ 40, até 52 unidades, 7 dias/unidade; cria função de multiplicador 1×/2× | Modifica dados de catálogo. **Não** considera pagamento como concedido; a autorização e entrega dependem dos serviços |
| `0076` | Histórico administrativo de suporte append-only | Não dá autoridade de aprovar pagamentos |
 
**Importante:** o migrador exige versões contíguas desde `0001`; copiar apenas 0073–0076 quebraria a verificação. Não alterar o histórico SQL já aplicado. A evolução exige plano de compatibilidade e backup/restauração comprovada. A função de XP passa a ser consultada em prêmios de batalha do código candidato; a ausência de entitlement mantém 1×.

## Quando parar e envolver o usuário

**AVISAR O USUÁRIO ANTES DE QUALQUER UM DESTES EVENTOS:**

1. Baixar, substituir ou executar código no PC onde o bot local está rodando.
2. Instalar `pnpm`, `node`, pacotes, arquivos binários ou dependências nessa máquina.
3. Reiniciar/parar processo, desconectar/reparear WhatsApp, alterar sessão Baileys ou credenciais.
4. Conectar/migrar/restaurar/editar o PostgreSQL do jogo, seja na máquina local ou remoto.
5. Trocar configuração de ambiente, ligar `PREMIUM_STAGING_ENABLED`, migrar uma PR para `main` ou admitir jogadores no novo build.

Não executar ações silenciosamente nem tratar `CI verde` como permissão para aplicar. Para versões locais, primeiro será preciso confirmar o SHA real, o processo em uso, local e identidade do banco (sem divulgar URL ou senha), existência de backup restaurável e janela de manutenção aprovada.

## Primeira sessão de aplicação local — roteiro NÃO EXECUTAR AGORA

1. Solicitar ao operador uma janela de manutenção. Identificar se o bot usa Windows, Linux, Docker, gerenciador de processos ou console; descobrir caminho da cópia que **realmente** executa, sem assumir que coincide com GitHub.
2. Em sessão supervisionada, checar de forma **somente leitura** o estado do repositório (`git status`, `git rev-parse HEAD`) e versões de Node/pnpm. **Não usar `git pull` ou `pnpm install` no passo de diagnóstico.**
3. Confirmar se a PR #228 já entrou em `main`, se a PR #227 foi rebaseada e qual release exatamente seria aplicada. Preservar edições locais e plano de retorno.
4. Determinar se há banco de produção ou staging e registrar **somente identificadores não secretos**; provar que banco staging/conta owner não são os dados reais. Não imprimir strings de conexão ou variáveis sensíveis no chat.
5. Verificar cópia de segurança, teste de restauração em outro banco, migrações pendentes e efeitos da `0072` sobre papéis.
6. Testar o build aprovado num ambiente descartável **separado**. Nunca reutilizar sessão/auth do WhatsApp vivo; aplicação ao bot local e ativação comercial são duas decisões distintas.
7. Somente após aprovação explícita, propor sequência controlada (drenar tráfego, backup, verificar, aplicar, smoke, monitorar, rollback se necessário) baseada em `docs/operations/release-recovery-runbook.md`.

## Pendências que impedem a ativação comercial

- Isolar uma API staging + PostgreSQL + conta owner de teste que não possam alcançar o banco ou os jogadores reais.
- Testar sessão/cookie de login, aprovação manual, entrega idempotente e interface em navegador real/Android.
- Revisão de autorização de `0072`, catálogo `2XP`, backup/rollback, custos e eventual integração comercial.
- Em `APP_ENV=production` o backend Premium da PR #227 está deliberadamente **OFF** mesmo com a flag definida; a política de ativação comercial de produção continua por projetar/aprovar. Não contornar a trava em segredo.

### Estado atual da tarefa

**Preparação remota apenas.** A etapa que requer o computador local **ainda não começou**. Quando a preparação chegar ao ponto de precisar do PC, avisar claramente o usuário e apresentar ações limitadas, reversíveis e instruções com acompanhamento.
