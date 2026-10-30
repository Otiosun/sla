# Pokémon Beyond — primeira cena Rotom com contrato canônico (25/10/2026)

**Estado:** PR Draft #257, branch isolada a partir da PR #256. Sem rota de gameplay registrada, sem banco/PM2/Baileys de produção, sem deploy.

## Resultado verificável desta fatia

Arquivos:
- `src/modules/exploration/expedition-whatsapp-scenes.ts`: apresentação **somente** de `FirstActionOutcome` + `EncounterView` observado de fato por `EncounterService.observe`. Compara player, release, local, encounter, forma e nível, rejeita CREATED e exibe apenas dados seguros. Captura somente depois do retorno canônico de `CaptureService`; não inventa XP, dinheiro, itens ou Ball extra.
- `tests/exploration/expedition-whatsapp-scenes.test.ts`: simulador sintético do relógio V1.1 com `advanceExpedition`, renderização, menu V1.7, falha fechada, privacidade, validação de cross-player e replay via `MessageRouter` + contrato do Outbox.

**Importante:** fixtures determinísticas (Shroomish / Campos de Yun / nível 5) são exemplos visuais de teste, não afirmam elegibilidade no catálogo publicado. A chamada de teste ao `MessageRouter` é sintética e definida apenas no teste. O bot real continua respondendo `/explorar` como consulta sob opt-in; novas ações ainda bloqueadas.

## Exemplo de mensagens emitidas pelas funções (fixture de teste)

Treinador: /explorar

RotomDex: registro read-only já existente (sob flag no staging, sem escrita).

Após uma primeira ação hipoteticamente **já confirmada** pelo adaptador transacional e encontro PRESENTED:

```text
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*
　RotomDex · Exploração

> _Bip-bip! Um Pokémon selvagem apareceu!_

◇ *Shroomish* · Nv. 5
⌖ *Local:* Campos de Yun
🕒 *Busca concluída:* 30 min · 690 min restantes

◇ *𝗘𝗦𝗖𝗢𝗟𝗛𝗔 𝗨𝗠𝗔 𝗢𝗣ÇÃ𝗢*

1. Batalhar
2. Capturar
3. Ignorar

› _Responda apenas com o número da opção._
```

Após `CaptureService.attempt` retornar sucesso **confirmado**, teste sintético:

```text
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗔𝗣𝗧𝗨𝗥𝗔*

> _Bip! Shroomish foi capturado!_
◈ *Destino:* Equipe · posição 2

› _Captura confirmada. Consulte /equipe ou /box para conferir._
```

Após retorno de tentativa **FAILED**, Rotom informa que o Pokémon escapou; não anuncia captura. Nenhum XP, dinheiro ou premiação se presume.

## O que foi e não foi comprovado

- ✅ Cenas renderizáveis a partir de objetos com contratos canônicos; validações de ligação por IDs internos não expostos ao jogador.
- ✅ Contrato de entrega privada e chave idempotente do Outbox em teste sintético, pela mesma classe MessageRouter.
- ⏳ CI da PR no SHA atual precisa ser conferida na API GitHub, sem inferir SUCESSO a partir de outros commits.
- ❌ Não foi executado PostgreSQL descartável **completo** para a sequência chat→efeito→observe→captura→recompensa.
- ❌ Não há rota real /explorar buscar/capturar conectada a estas cenas. Não é UAT WhatsApp de verdade.
- ❌ Não existe autorização final dos resultados NO_SIGNAL/TRAIL/INCIDENTAL/DIRECT, nem catálogo ativo/loot aprovado ou integração XP da batalha. Não habilitar busca universal com encontro garantido.
- ❌ Não houve deploy, merge, atualização do bot, migração nem chamada Baileys real.

## Próximo gate

1. CI/TypeScript/Biome desta branch; consertar falhas reais e registrar SHA final.
2. Orquestrador isolado para primeira busca: resolver expedição/jogador/área/release/horário e resultado autorizado; executar `PostgresExpeditionFirstAction.execute/executeNext` com o `canonicalExpeditionDirectEncounterEffect` somente quando permitido.
3. Após commit do encontro, observar via `EncounterService.observe`, persistir delivery no Outbox, oferecer comandos somente com contexto/versionamento do menu. Replay e concorrência sem cobrar de novo.
4. Captura via `CaptureService.attempt` (Ball canônica), batalha por motor PvE + projector real de XP. Não simular ganhos como se fossem legítimos.
5. Teste de cenário completo em PostgreSQL descartável; prova de replay, rollback e saídas reais por mensagem. Reconciliar #255/#256 sem merge automático.
6. Só após autorização explícita e restore comprovado: staging, UAT de WhatsApp real, aplicação controlada em produção.
