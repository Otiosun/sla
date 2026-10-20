# Pokémon Beyond — aplicação local Central Premium (Gate F6)

> CÓDIGO CANDIDATO, NÃO INSTALADO. Este documento não autoriza operações no computador, sessão WhatsApp, PostgreSQL real, ou site em produção.

## Arquitetura

- WhatsApp/Baileys continua no PC em `src/main.ts`; não inicia outro worker.
- API HTTP Companion no mesmo PC: `src/player-portal-main.ts`, processo **separado**, sem sessão Baileys, conectado ao banco já usado pelo bot.
- A API usa `PLAYER_PORTAL_HOST=127.0.0.1` e `PORT=3000` (ou porta livre). Não abrir a porta para LAN ou internet.
- Site Vercel BFF acessa o PC apenas através de uma origem HTTPS que o operador já controla, com encaminhamento auditado para loopback. O Vercel NÃO alcança o localhost do PC diretamente.
- Reusar `PLAYER_PORTAL_API_BASE_URL` só se o operador provar que aponta para essa instalação local e não para servidor legado/staging.

## Código do bot #229: desbloqueio local OFF por padrão

- `PREMIUM_LOCAL_DELIVERY_ENABLED=1` requer `APP_ENV=development` ou `production`, `PLAYER_PORTAL_HOST=127.0.0.1` (ou `::1`) e chave de sessão válida de 32 bytes.
- `APP_ENV=production` exige commit SHA completo via `DEPLOY_REVISION` ou `RAILWAY_GIT_COMMIT_SHA` conforme runtime existente.
- `PREMIUM_STAGING_ENABLED` continua um modo **separado**. Local não exige Supabase de staging ou Railway.
- Esse modo ativa leitura, suporte, entrega manual de itens/Pokémon/MASTER/XP2X. Não liga pedidos pagos, aprovação financeira ou checkout.
- Apenas a ativação da API separada não instala/atualiza o bot existente nem migra o banco. O processo WhatsApp nunca deve ser iniciado em duplicidade.

## Inspeção somente leitura (quando o operador autorizar no PC)

Executar na **pasta que realmente está em execução**, antes de instalar ou substituir qualquer coisa:

```sh
git status --short
git rev-parse HEAD
node --version
node --env-file-if-exists=.env scripts/operations/premium-local-readiness.mjs
```

O script não usa rede, banco, WhatsApp, npm/pnpm, escrita em arquivos ou logs de segredos. Sua saída informa apenas SHA, branch e booleanos de configuração. Exit 2 significa pré-requisitos faltando, não tentativa de alteração.

## Gate que AINDA precisa de autorização para aplicação real

1. Confirmar pasta/processo reais, arquivos alterados, `APP_ENV`, Node/pnpm e tipo/local do banco, sem compartilhar senhas.
2. Comprovar backup consistente e **restauração testada** do PostgreSQL; preservar sessão Baileys e chave de criptografia.
3. Auditar migrações pendentes 0063–0077; 0072 altera permissões ADM e 0075 define catálogo XP2X. Migrador exige sequência íntegra e não permite editar checksums.
4. Construir e testar o candidato em **cópia isolada** com banco descartável; jamais iniciar segundo WhatsApp conectado à sessão real.
5. Só durante janela aprovada: aplicar migrações canônicas, validar grants e iniciar apenas a API Companion em loopback. Smoke anônimo: `/health` 200 e `/v1/hub/player/self` 401.
6. Revisar owner, sessão separada, CSRF, MASTER publicado, logs e idempotência. Toda concessão real exige confirmação humana prévia de destinatário, conteúdo e quantidade.
7. Verificar que a origem HTTPS do Hub chega a essa API local; se necessário, discutir configuração segura **sem expor porta ou credenciais**.
8. Site #108: UI compilada com `VITE_PREMIUM_LOCAL_UI=1` e `VITE_PREMIUM_LOCAL_TARGET=production`; Vercel backend `PREMIUM_LOCAL_ENABLED=1`, `PREMIUM_LOCAL_APPROVED_ORIGIN` deve coincidir exatamente com o `PLAYER_PORTAL_API_BASE_URL` verificado. Nenhuma flag foi ligada.
9. Verificar em navegador real: owner/não-owner, cookies separados, CSRF, Master Ball, outros itens, XP2X, replay sem duplicação e HTTP 404 nas ações antigas de pagamento.
10. Rollback: desabilitar as flags e o processo HTTP; retorno do código do bot sujeito à compatibilidade de schema, nunca apagar histórico de migrações. Restaurar banco somente sob plano aceito.

## Estado

- PR #229 bot: código candidato + preflight; não aplicado localmente.
- PR #108 site: modo local protegido + preview; não mesclado nem publicado em produção.
- Site e bot NUNCA confirmam pagamento. A verificação externa é humana, a entrega é operação auditada do ADM.
- CI descartável é evidência de código, não prova que o banco e PC do operador estão prontos.
