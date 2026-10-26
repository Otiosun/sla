# Pokémon Beyond — Exploração: contrato de UX aprovado (V4, 26/10/2026)

**Status:** UX de exploração aprovada em conversa e screenshots pelo proprietário para os painéis de preparação, exploração ativa e encontro incidental (inclusive hierarquia de captura); DIRETRIZ DE DESIGN, **não implementada nem publicada**. Integrar à UX atual, sem refazer serviços existentes ou mudar regras mecânicas silenciosamente.

**Repositório:** `Otiosun/sla`, PR Draft #257; sem merge, migração, deploy, PM2, Baileys, banco produtivo ou jogadores reais.

## 1. Objetivo e regra de ouro

Interface de WhatsApp em **duas camadas**:
- **Visível, acima da dobra:** reconhecimento imediato do estado, resultado e dado principal. Um veterano conhece o comando ou a escolha corrente e não precisa tocar em "Ler mais" sempre.
- **Expandida, abaixo da dobra:** escolhas numeradas, instruções, detalhes, inventário elegível, mensagens de auxílio. Iniciante encontra todas as opções sem decorar comandos.
- Uma resposta por decisão/resultado quando possível. Evitar telas de seleção aninhadas e mensagens repetidas, preservar estilo existente Bell/Rotom, não imitar a decoração de outro bot.
- **Exceções:** apresentação inicial de /explorar aberta (usuário aprovou); confirmação irreversível de encerrar e erros curtos também abertos.
- `[Ler mais]` abaixo é **marcador de design**, jamais texto a enviar. No teste do usuário em WhatsApp Android, sequência longa do combinante U+031D (`̝`) após a parte visível induziu o "Ler mais". A posição e suporte a texto/legenda de imagem precisam ser validados em WhatsApp real / Baileys, iOS e Android. **Não assumir garantia universal**, não deixar caracteres não imprimíveis comprometerem acessibilidade ou limites de caption. Usar um utilitário comum de apresentação, configurável e testável, não copiar centenas de sinais para cada renderer manualmente.

## 2. Decisões confirmadas pelo proprietário

1. `/explorar` quando NONE apresenta mecânica e escolha **diurno** (06:00–18:00) ou **noturno** (18:00–06:00), **sem** [Ler mais] na abertura; 12 horas internas, 3 expedições/semana, local real. Abrir menu não gasta tempo/cota.
2. A opção do período abre estado PREPARING com horário escolhido, área, 12h e "cota ainda não consumida"; **[Ler mais] depois do status**, antes das ações: buscar, recursos, destinos, alterar período, cancelar preparação. A primeira ação efetiva com custo, e não o menu, consome uma cota. Troca de período antes da primeira ação; não trocar durante ACTIVE.
3. ACTIVE usa topo condensado: `◇ *𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*`, `🌙 *20:15*`, `⌛ Restam `9h45``; **[Ler mais]**; abaixo `1. 🔎 Buscar Pokémon`, `2. 🎒 Buscar recursos`, `3. 🗺️ Viajar`, `4. 📋 Encerrar` (quando opções de fato disponíveis). Não exigir consulta a menus para veteranos, mas opções continuam acessíveis.
4. **Encontro incidental aprovado no screenshot/texto do usuário:** topo `✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*`, frase curta em citação, `◇ *Zigzagoon* ● `Nv. 6``; **[Ler mais]**; abaixo contextualização e `◇ *𝗔ÇÕ𝗘𝗦*` com `1. ⚔️ Batalhar`, depois seção subordinada `◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔𝗥*` com `2. ◉ Poké Ball ● `×3``, `3. ◈ Great Ball ● `×1``, `4. ✧ Ultra Ball ● `×1``, e `0. ↩️ Ignorar ● `10 min``. **A separação hierárquica AÇÕES/CAPTURAR é intencional.** Quantidades são do inventário REAL; não afirmar que essa lista exata pertence ao jogador.
5. **Uma escolha de Ball dispara imediatamente a tentativa do serviço canônico de Capture**, sem "Capturar → escolher Ball → confirmar" nem inventário da exploração. Após falha: mostrar resultado, saldo atualizado e escolhas correntes na mesma resposta, se o encontro persistir. Captura bem-sucedida: resultado confirmado e TEAM/BOX real; nunca inventar XP por captura, bônus, chances ou grants.
6. Encontros selvagens prioritariamente com **imagem Pokémon + cenário licenciado/curado e coerente** (área/período/superfície/microhabitat) e legenda com hierarquia acima, numa única mensagem quando tecnicamente suportado. Fallback visual limpo sem cenário incompatível. Shiny apenas após resultado canônico confirmado; **nunca** extrapolar espécies ilustrativas para tabela PUBLISHED.
7. A opção **Batalhar** transfere para o **PvE existente** (Encounter/Scene/Battle/Progression); o desenho do fluxo de batalha está EXPRESSAMENTE **provisório e sujeito à revisão específica de PvE**. Não impor screenshots anteriores de PvE como layout final, não criar outro motor. `/equipe`, `/inventario`, viagem World, serviços, captura, recompensas reutilizam implementações canônicas.
8. Menus vistos repetidamente podem dobrar, mas erro curto/ação sensível irreversível mostra decisões visíveis; em um único menu, índices devem pertencer exclusivamente ao estado vigente. Atalhos de veterano devem revalidar servidor e NÃO transformar números antigos em gasto novo silencioso.
9. Relatório de conclusão mostra resumo no topo e histórico sob [Ler mais], é factual; relatório escrito **externo** (>=100 palavras) e prêmio final apenas após aprovação staff, sem duplicar XP, moedas, itens ou instâncias já obtidas.
10. A escolha de período e exposição de informações devem usar release ACTIVE/PUBLISHED e conhecimento desbloqueado; não revelar espécies secretas, não forçar viagem sem `explorationMinutes` aprovado por conexão, nem garantir encontros.

## 3. Referências literais de interface aprovadas

### 3.1 Abertura — sem expansão

```text
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*
> _Bip-bip! Uma nova aventura espera por você!_

Explore áreas acessíveis, encontre Pokémon
selvagens, reúna recursos e descubra
o que a região tem a oferecer.

◇ *𝗦𝗨𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*

*⌖ Local:* Campos de Yun
*🎟️ Disponíveis:* 3/3
*⌛ Duração:* 12 horas internas

> O tempo avança conforme suas ações. A primeira ação efetiva utiliza uma cota de exploração.

◇ *𝗘𝗦𝗖𝗢𝗟𝗛𝗔 𝗢 𝗣𝗘𝗥𝗜́𝗢𝗗𝗢*

1. ☀️ *Diurno* · `06:00–18:00`
2. 🌙 *Noturno* · `18:00–06:00`

> _O período influencia os encontros._
> _`/equipe` ● `/inventario` ● `/explorar ajuda`_
```

### 3.2 Estado PREPARING (dobra antes das ações)

```text
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*
> _Exploração noturna preparada!_

🌙 `18:00 → 06:00`
⌖ *Campos de Yun*
*⌛ 12h* disponíveis
*🎟️ Cota ainda não consumida*

[Ler mais]

◇ *𝗔ÇÕ𝗘𝗦*

1. 🔎 Buscar Pokémon ● `30 min`
2. 🎒 Buscar recursos ● `60 min`
3. 🗺️ Consultar destinos
4. 🔄 Alterar período
5. ↩️ Cancelar preparação

> _A primeira ação com custo inicia a aventura_
```

### 3.3 Estado ACTIVE — curto e memorizável

```text
◇ *𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*
🌙 *20:15*
⌛ Restam `9h45`

[Ler mais]

1. 🔎 Buscar Pokémon
2. 🎒 Buscar recursos
3. 🗺️ Viajar
4. 📋 Encerrar
```

### 3.4 Encontro incidental — combate e Balls no mesmo menu

```text
✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*
> _Bip! Um Pokémon inesperado cruzou seu caminho!_

◇ *Zigzagoon* ● `Nv. 6`

[Ler mais]

> _Você procurava outra espécie, mas encontrou um Zigzagoon pelo caminho..._

◇ *𝗔ÇÕ𝗘𝗦*

1. ⚔️ Batalhar

◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔𝗥*

2. ◉ Poké Ball ● `×3`
3. ◈ Great Ball ● `×1`
4. ✧ Ultra Ball ● `×1`

0. ↩️ Ignorar ● `10 min`
```

**Atenção:** Zigzagoon Nv. 6, quantidade de Balls e local são apenas exemplos de copy, não conteúdo/loot efetivamente permitido pela release. Quando uma Ball está ausente, não oferecer a ação nem reatribuir seu número de forma que uma resposta antiga consuma outra. O custo `10 min` vale para ignorar **encontro incidental** segundo baseline, não para toda fuga.

## 4. Roteamento canônico e riscos de integração

- PREPARING e ACTIVE já existem no domínio `expedition-state.ts`; relógio/cota devem ser transacionais via `PostgresExpeditionFirstAction` na mesma unidade de trabalho do efeito e recibo idempotente.
- O renderer exploratório existente está em `expedition-rotom-presentation.ts` e `expedition-whatsapp-scenes.ts` na #257, porém **a rota /explorar em Draft é apenas de consulta read-only e bloqueia ações**. O próximo trabalho NÃO consiste em publicar a simulação como está.
- PvE usa `pve-scene-whatsapp.ts` e políticas de grupo/runtime que exigem reconciliação com #255. A transição Batalhar deve respeitar autorização/capability sem habilitar comandos de staff. Próxima revisão dedicada PvE pode mudar o texto e HUD de combate.
- Captura requer EncounterService consistente + CaptureService.attempt com idempotência e inventário. Os números 1/2/3/4/0 são somente escolhas do **menu atual validado pelo servidor**; não armazenar comandos de usuário ambíguos como gasto autorizado.
- Rotom não deve enviar opções de batalha/captura sem handlers autorizados; o delivery sombra atual usa `choices: []`, correto até integração real.
- Falha de saída/Outbox não pode gerar novo encounter ou duplicar tentativa, prêmio, equipe ou cobrança de expedição.
- O "Ler mais" é uma decisão de apresentação, nunca uma condição do backend: comandos funcionam sem expansão do cliente.

## 5. O que ficou aprovado x o que NÃO ficou fechado

**Aprovado no design:** identidade visual e hierarquia da intro, PREPARING, ACTIVE e incidental; preâmbulos curtos com opções atrás de [Ler mais]; lista de Balls dentro do encounter; comportamento direto para veteranos; imagens de encontros quando curadas; reuso dos fluxos oficiais; menos spam.

**Pendente de UX:** refinamento textual de busca livre/direcionada, rastros, recursos, serviços, viagens, relatório final e exceções; imagens/licenças; medidas reais de comprimento/combining chars e acessibilidade; suporte de legendas nos clientes; confirmação dos índices estáveis e fluxos de erro. Não confundir simulação V4 inteira com aprovação irrevogável de todos os ramos.

**Pendente de engenharia:** validação da release LIVE, escolha autoritativa NO_SIGNAL/TRAIL/INCIDENTAL/DIRECT, custo de viagem, rotas mutáveis, PvE/captura/XP no WhatsApp real isolado, reconciliação PR #255/#256, migração numerada, UAT, backup/restauração e autorização de cutover.

## 6. Testes de aceitação UX que devem acompanhar a implementação

- Para menu ACTIVE, topo visível preserva contexto e veterano consegue executar opção vigente sem expandir.
- Para PREPARING, alteração de período antes do primeiro custo não consome cota; após ACTIVE é proibida.
- Para encontro incidental, texto e imagem (quando houver) apresentam espécie legítima e somente Balls disponíveis, e a escolha captura em UMA interação, sem UI extra.
- Retry/reenvio da mesma entrada não gasta duas Balls e não gera dois Pokémon.
- Se inventário/Encounter mudar antes da resposta, recusa segura, atualiza escolhas sem transferir números para itens errados.
- Controles sensíveis — encerrar, alterações persistentes, gasto de Ball — têm autorizações inequívocas e comportamento fail-closed; encerramento voluntário confirma visivelmente.
- Android/iOS/WhatsApp Web, texto e caption: confirmar se "Ler mais" aparece no ponto pretendido e se não há mensagem truncada/inacessível. Fallback sem dobra mantém navegação completa.
- Replays, saídas de menu e contexto cruzado grupo/DM não vazam localização/estado ou produzem ações fora da sessão.
- PvE integra como sistema independente; mudança futura de HUD de PvE não quebra o menu do Encounter.
