# Pokémon Beyond — Auditoria de proveniência UX e reconciliação seletiva — 02/11/2026

**Status:** PROVA DE CÓDIGO EM DRAFT. **Não instalada no bot local, não validada em handset, não aprovada para anúncio.**

## Referências imutáveis

- Candidato de integração antes desta auditoria: `Otiosun/sla` PR #316, `20a0382d9ca67d67e89ab682954566b5c4987b49`. CI #41475147996: 159 Vitest, 32 PG18 descartável, tsc/Biome/build.
- UX contextual de batalha: `Otiosun/sla` PR #255, `31bde8ec053081ece858bb1c3d4f0afa79c96afd`. Base divergente da candidata. GitHub Compare #255...#316 = `diverged`, 630 commits ahead / 128 behind; merge base `8ca711cd87f21ada605e7dcf7651990ef20748e4` no momento da leitura.
- Contrato **aprovado** de exploração: `docs/ux/EXPLORATION_PLAYER_FLOW_UX_V4_APPROVED_20261026.md`, blob SHA `207c35ff7dbe0626de2fa79a6b054966442e4805`, está na árvore #316 e **não** na PR #255. Explicitamente DESENHO, não prova de envio no WhatsApp.
- O HUD vetorial V1 da #255 era **somente protótipo de design, não aprovado visualmente**. Sua referência foi preservada nesta branch **idêntica byte a byte**, mas **não** integrada no código ou enviada aos jogadores. O documento também alerta sobre política de licença dos sprites.

## Prova de versões por blob Git, antes da reconciliação

| Caminho | SHA blob PR #255 | SHA blob #316 | Veredito |
|---|---|---|---|
| `src/modules/battle/pve-scene-whatsapp.ts` | `3f15d8a1f61d2c5c90f0c032a16de9ffd27dc69b` | `6eda4410a8963f41155b6a7e9a5002fd2f04e4fb` | Divergente. Faltava orientação contextual de turno, reserva, PVP secreto e fuga. |
| `src/modules/messaging/operational-ux-handlers.ts` | `fb233930f0c46e178868e2cfdb19b797335f3625` | `6545790e5c5af382e05d2a697e5c94dc6ae24e34` | Divergente. `/combate` omitira `/moves`, seção de ações e condição da troca. |
| `src/modules/pvp/whatsapp-handlers.ts` | `f9a9859c167a9c65f50271b038a435d91141ae32` | `9c9531980fdf688f40ce81dc5671bd24490f83ad` | Divergente. Retomada de desafio e políticas devem ser reconciliadas separadamente (ports também diferem). |
| `src/modules/progression/whatsapp-handlers.ts` | `aa1fd5c6e0c12c871eadafde7578025e2f1247cd` | `c4ff19b10b28ec386d810d6b7f713a7597ad8b26` | Divergente; o código novo é maior, NÃO substituir sem revisão de evolução/moves. |
| `src/modules/messaging/router.ts` | `f676cdb738fecbcedc6708a7ca797644f7f98504` | `b8832c25d4908dbc67e4cacb1617e826bf0a9738` | Divergente; candidate contém integrações de exploração mais recentes. |
| `src/runtime/compose-whatsapp-runtime.ts` | `28ae566bd876be0f074aa647fd5f0e925ed491fb` | `71f717a051f6456620e5e2eba0e89edee26f0487` | Divergente; nenhum desses SHAs prova a versão carregada pelo PM2. |
| `docs/ux/COMBAT_CENA_50_WORDS_PVP_PVE_UX_20261026.md` | `68329dda96e3946aa54b5af772a57eb0df6c7844` | Mesmo SHA | **Idêntico no Git**. |
| `docs/ux/JORNADA_NARRADA_PLAYER_NARRATOR_FLOW_V1_CANDIDATE_20261026.md` | `b34fc0b975bf8c7ee43320c6a995ada12beff26d` | Mesmo SHA | **Idêntico no Git**. |

## Decisão e trabalho aplicado nesta branch Draft

1. **Não fazer merge/cherry-pick da PR #255 inteira:** 128 commits exclusivos para trás, runtime/rotas/ports e políticas que podem conflitar com o candidato mais novo.
2. **Restaurar seletivamente** de `pve-scene-whatsapp.ts` PR #255 apenas o bloco de orientação contextual (sem mudar contrato mecânico): `/moves`, `/movimento <número>` só quando há PP, `/trocar` só com reserva viva e índice real, `/fugir` só em encontro WILD, ausência de movimento adversário antes da resolução PVP, controlador AUTO e NARRATOR informados.
3. **Restaurar** o texto literal e semântica do guia `/combate` da PR #255 (seção ações do turno, `/moves`, `/movimento`, `/trocar` condicionado, PVE/PVP) sem substituir rotas e políticas posteriores do arquivo.
4. **Reintegrar os 4 testes funcionais exatos da PR #255** que estavam ausentes do candidato: 3 da cena de batalha contextual + 1 do guia /combate; executar CI estrita.
5. **Preservar byte a byte** quatro documentos que só existiam na #255: HUD vetorial **candidato não aprovado**, gates da cena de combate, auditoria de spawn/narrador e shadow gate da exploração; documentos são referência, não recursos ativos.

## O que ainda NÃO está correto/provado no release

- A árvore Draft contém diferenças semânticas não conciliadas de PvP (`/aceitar`, retomada), gestão Pokémon, paginação/retorno de `/equipe`, controle de comandos de grupo e policies de `/ir`. A #255 possui testes adicionais ausentes do candidato. Requer revisão seletiva com provas e CI; não certificar equivalência.
- A UX V4 de exploração inclui o painel incidental `◇ AÇÕES / ◇ CAPTURAR` e uso de `[Ler mais]` como **marcador de DESIGN, jamais texto literal**; atualmente o emissor ACTIONABLE só funciona offline, somente captura e não oferece Batalhar. Portanto o fluxo aprovado **ainda NÃO está integralmente implementado nem homologado**.
- Teste sintético de grupo/Outbox, snapshot e screenshots em CI NÃO prova dobra nativa WhatsApp, mídia final nem interface do jogador. UAT Android/iOS/Web com Baileys real obrigatória.
- `Otiosun/pokemon-hub-web` PR #132 (HEAD `b997f1e6d2c5d5effced6e396ceca8607b8d34db`) é **outro repositório**, DRAFT, e protege feedback/auditoria Premium. Não está instalado automaticamente pela branch do bot.
- Não temos prova da versão **realmente carregada no bot do Windows** sem inspeção autorizada de diretório, processo PM2 e builds locais. Comparação Git só prova código candidato.
- Migrações, backup externo criptografado com restauração comprovada, rollback, testes reais e GO ainda bloqueiam publicação/anúncio.

**Prova de fluxo ativo:** exige artefato de build identificado por commit SHA e hash do runtime, backend Hub alinhado à sua PR e teste no cliente WhatsApp real. Nada disso é inferido de CI isolada.

[Gate #264](https://github.com/Otiosun/sla/issues/264) · [PR UX #255](https://github.com/Otiosun/sla/pull/255) · [PR Hub #132](https://github.com/Otiosun/pokemon-hub-web/pull/132)
