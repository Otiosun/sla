# Pokémon Beyond — Manifesto verificável de candidata integrada (02/11/2026)

**Status da release: NO-GO.** Este é o manifesto de uma ÁRVORE CANDIDATA Git, não uma instalação Windows nem uma versão disponível aos jogadores.

## Uma única árvore de integração

- Branch para revisão: fix/ux-pvp-accepted-start-resume-20261102 / [PR #318](https://github.com/Otiosun/sla/pull/318) Draft, empilhada sobre #317 e #316.
- Candidato Windows original: [PR #287](https://github.com/Otiosun/sla/pull/287), SHA aefeb2c2d20f4f40ed9a3f1f52bcb57dcb9229fe. Comparação GitHub #287...#318 confirmou **ahead 266 / behind 0** no checkpoint anterior a este documento: a árvore da #287 é ancestral Git direto.
- Stack exploração/captura: #299–#316 (Outbox post-SENT, menu emitido, identidade/revisão, transação, captura real PG18, concorrência, recuperação da confirmação e ACTIONABLE exclusivamente offline).
- UX contextual: #317 recuperou da #255 exatamente o bloco de orientação de batalha e o guia /combate e reintroduziu quatro testes e quatro documentos históricos com SHA Git idêntico. #318 recupera o fluxo de retomada de desafio PvP aceito e testa o banco real.
- UX anterior: [PR #255](https://github.com/Otiosun/sla/pull/255), SHA 31bde8ec053081ece858bb1c3d4f0afa79c96afd, não é ancestral: comparação com #318 era **diverged, ahead 651 / behind 128**. Não fazer merge cego; conciliar funcionalidade a funcionalidade com testes.
- [Auditoria por arquivo e SHA](../ux/UX_VERSION_PROVENANCE_AND_RECONCILIATION_20261102.md).
- Hub Premium: [Otiosun/pokemon-hub-web PR #132](https://github.com/Otiosun/pokemon-hub-web/pull/132), SHA b997f1e6d2c5d5effced6e396ceca8607b8d34db, DRAFT em OUTRO repositório. Preview READY não é produção nem prova UAT autenticada.

## O que é obrigatório antes de atualizar o bot local e anunciar

1. Backup externo criptografado, autenticado e com restauração testada de DB, mídia, ignorados e estado necessário da sessão Baileys; plano de rollback.
2. Manifesto VERIFICADO do checkout Windows real e do processo: SHA do commit, alterações não comitadas, hash do build, PID/caminho e versão do PM2, apontamento do DB. Não inferir isso da CI GitHub.
3. Consolidação e revisão das PRs Draft, auditoria UX/Hub, regressão crossmodule integral, migrações numeradas e teste de restauração isolada.
4. Sandbox WhatsApp Baileys real em Android/iOS/Web, dobra nativa Ler mais, telas/contextos do jogador, mensagens citadas e recovery; respeitar licença de imagens.
5. GO explícito, cutover monitorado, verificação posterior e anúncio só de funções realmente habilitadas.

## Ressalvas de UX

O contrato APROVADO docs/ux/EXPLORATION_PLAYER_FLOW_UX_V4_APPROVED_20261026.md prevê hierarquia AÇÕES/CAPTURAR, Batalhar, Ignorar, mídias e dobra. A stack #316 ainda emite ACTIONABLE somente em TESTE OFFLINE e oferece captura sem batalha/ignorar plenamente jogáveis ou dobra nativa homologada. O HUD vetorial V1 da #255 é PROTÓTIPO NÃO APROVADO; sprites exigem direitos avaliados. Outras diferenças de equipe, boxes, progressão e políticas de acesso continuam pendentes. Não declarar UX integralmente aplicada.

[Checklist #264](https://github.com/Otiosun/sla/issues/264) | [Handoff Komekko](https://docs.google.com/document/d/1DfnnIPbDPw4obRM-PjrvAySYwiKt0B6R60zrNz1l_bw/edit) | [Gate local](LOCAL_CUTOVER_AND_ANNOUNCEMENT_GATE_20261101.md)
