# Pokémon Beyond — Exploração Autônoma / Spawn Individual V1

**Origem:** dossiê de produto consolidado pelo usuário em 23/10/2026.  
**Estado:** especificação aprovada conceitualmente; ainda não publicada e sem fluxo WhatsApp de exploração integrado.  
**Implantação:** fases V1.1–V1.7 em PRs separadas; não tocar em PM2, WhatsApp, banco de produção, sessões ou jogadores reais sem gate e autorização.

## 1. Propósito e fronteiras

- **Jornada narrada:** missões, NPCs importantes, história, ginásios, conteúdo restrito, intervenções narrativas/administrativas.
- **Exploração Autônoma:** caça individual, viagens, batalhas/capturas, recursos e serviços em áreas abertas sem narrador permanente.
- Coexistem. A exploração não revoga as regras de Jornada fora da sessão autônoma.
- **Spawn competitivo** em grupo é independente: frequências, regras de grupo e pools próprios. Não compartilhar indiscriminadamente política de surgimento, recompensas ou raridade com spawn individual. Reutilizar apenas catálogos, instâncias e mecanismos mecânicos realmente compatíveis.
- A UX deve parecer uma aventura Pokémon guiada por Rotom, não um painel de formulários nem uma cadeia interminável de comandos.

## 2. Expedições e relógio — baseline

| Regra | Decisão |
|---|---|
| Limite | 3 expedições/semana; nenhuma cota diária adicional |
| Reset | Segunda-feira às 00:00 (proposta técnica; confirmar fuso do mundo) |
| Concorrência | No máximo 1 expedição ativa por jogador |
| Diurna | 06:00–18:00 |
| Noturna | 18:00–06:00 |
| Duração | 12 horas **internas**, não horas reais |
| Consumo de cota | Somente na primeira ação efetiva que gasta tempo; abrir menu/preparação não consome |
| Sessão | Pausável/retomável entre mensagens e reinicializações do bot |
| Final | Encerramento voluntário, limite do relógio ou derrota total |

`/explorar` é a entrada por barra. Rotom informa localização, cota semanal, dia/noite e opções de preparação: equipe, mochila, destino e cancelar. O relógio avança **por ações**; fases manhã/meio-dia/tarde/entardecer/noite/madrugada são apenas marcos narrativos, não um clique por fase. Consultas gratuitas não devem consumir minutos. Sem pontos de exploração, energia, limite artificial de cliques ou cronômetro real para resposta.

**Tempos iniciais por ação:** buscar Pokémon 30 min; seguir rastros 15 min; ignorar incidente 10 min; batalha concluída 30 min; buscar recursos 60 min; Centro Pokémon 30 min; ver equipe/inventário/RotomDex 0 min; PokéMart sem tempo relevante. **Viagem:** custo da conexão real, jamais adotar os 45 min do exemplo como verdade de rota.

Ao alcançar o horário final, não iniciar novas ações de campo. Batalhas que começaram legitimamente antes do fim podem concluir; resolver integração de cobrança/limite sem perder o estado do encontro.

## 3. Mundo, localização e conexões

- Recorte inicial: **Vila dos Arrozais** (segura, Centro, PokéMart) e **Campos de Yun** (área aberta).
- Catálogo autorado tem 6 áreas, mas só estas 2 têm conexão e conteúdo mecânico correspondente ao escopo inicial. As outras 4 **não** são habilitadas por mero cadastro.
- No código versionado `src/modules/world/zhoulia-content.ts`, a Vila possui 4 pools (dia-terra, água, raro, noite-terra) e Yun 3 pools (dia-terra, rios, noite-terra). O balanceamento atual em `zhoulia-encounter-balance.ts` define Vila níveis 2–5, Yun 4–8, peso 100 para cada entrada. **São fatos do código auditado, não prova da release efetivamente carregada na base live.**
- Mostrar rotas apenas ao escolher viajar; somente destinos acessíveis. Seleção executa deslocamento, custo por conexão e persistência de local.
- Sem teleporte arbitrário ou menus de sub-rotas durante toda busca.
- Encerramento **não teleporta** de volta à Vila; próxima expedição pode começar na localização persistida.
- Áreas com acesso restrito ou sem tabela/conteúdo mecânico adequado são inelegíveis.

## 4. Caça individual

### Livre
Busca sem espécie determinada usando tabela local, horário, superfície, clima/unlocks quando aplicáveis, ecologia, status ativo e regras de exclusão. Possibilidade de descobrir espécie nova para a Pokédex.

### Direcionada
Só permite espécie previamente **AVISTADA ou CAPTURADA**, atualmente elegível em tabela efetivamente ativa naquela área/horário/superfície/condições. Espécie restrita a Jornada, evento ou staff não entra. Rotom orienta sobre onde e quando procurar usando **somente conhecimento já desbloqueado**, sem vazar espécies desconhecidas ou locais secretos. Habitat textual genérico da Pokédex não equivale a spawn mecânico.

Peso de alvo multiplicado por **3**, com pesos dos concorrentes mantidos e renormalização. Para probabilidade-base `p`, chance final `3p/(1+2p)`. Exemplos: 1%→2,94%; 5%→13,64%; 10%→25%; 20%→42,86%; 30%→56,25%. O teto de 50% aventado no início foi **descartado**. Sem encontro garantido e sem bônus automático de shiny, IV ou nível.

### Resultados possíveis da busca
1. **Nenhum sinal:** custo 30 min, opções continuar, trocar alvo ou parar.
2. **Encontro incidental:** outro Pokémon aparece; opções combater, capturar ou ignorar (10 min) e retomar busca.
3. **Rastros do alvo:** seguir (+15 min) leva ao encontro no baseline recente; também pode rebuscar ou abandonar.
4. **Encontro direto:** quando tabela/motor permitem.

Não há contagem fixa de buscas para espécies raras. Shroomish, Zigzagoon, Ralts, Taillow e Magikarp apareceram em **simulações ilustrativas**, não são confirmação de spawns liberados em Yun.

## 5. Repel (condicionado a catálogo funcional)

Duração inicial **3 horas internas**. Compara encontro com o **primeiro Pokémon da equipe**. Suprime espécies de nível inferior; pode suprimir inclusive alvo direcionado. Rotom deve advertir se o alvo seria filtrado. Encontro suprimido **não** dispara reroll gratuito: Repel não aumenta artificialmente frequência de raros. Verificar item/efeito no catálogo ativo antes de expor o sistema.

## 6. Combate, captura e progressão

O orquestrador de exploração cria um encounter individual legítimo e delega a **EncounterService**, motor de batalha, Capture, ProgressionService, roster TEAM/BOX, Pokédex, inventário, economia e WhatsApp outbox existentes.

- **Vitória PvE:** na regra anteriormente auditada, +100 progressão do treinador e XP pelo modelo `BASE_EXP_LEVEL_DIV_7_V1` ao Pokémon vencedor ativo final. Confrontar a regra com o runtime ativo antes de aplicar.
- Sem dinheiro automático por toda batalha; captura não dá XP ou prêmio extra de KO.
- Captura consome 1 Ball por tentativa conforme motor. Se bem-sucedida, cria **exatamente 1 instância** preservando shiny, natureza, habilidade, IV, gênero, golpes etc., registra Pokédex, TEAM se couber, BOX quando preciso.
- Fugir ou perder não concedem vitória. HP/status/itens e XP já obtidos persistem.
- Encontro e cena visual mantidos consistentemente durante batalha/captura; não apagar encounter ativo em meio ao fluxo.

## 7. Recursos locais — baseline de balanceamento

Buscar recursos custa **60 minutos internos**. Tabela inicial **por área** a confirmar:

| Sorteio | Chance |
|---|---:|
| Nada útil | 75% |
| Poké Ball ×1 | 15% |
| Potion ×1 | 7% |
| Poké Ball ×2 | 2% |
| Potion ×2 | 1% |

25% de sucesso e 75% sem item, por busca. Valores esperados: **0,19 Poké Ball**, **0,09 Potion** e **₽65 em mercadorias** (Poké Ball ₽200, Potion ₽300). Em 12 buscas puras, aproximadamente **₽780 em mercadorias**, sem viagens, batalha ou outras ações. São médias matemáticas, não entrega fracionada.

Itens são aplicados imediatamente e idempotentemente ao inventário. Não criar crafting, peso, materiais sem função, dinheiro por busca ou distribuição global de itens especiais. Berries, medicamentos e Repel somente após catálogo e balanceamento reais.

## 8. Serviços geográficos

- **Centro Pokémon:** só se a área possuir o serviço; utiliza cura canônica, consome 30 min internos, não em batalha incompatível.
- **PokéMart:** só onde há loja; produtos, preços, compras e saldo pela economia já existente. Sem brindes ou catálogo inventado.
- A admissão narrativa por cena de 50 palavras, válida em certos serviços da **Jornada**, será substituída por **localização válida + expedição ativa** para o modo autônomo. Não remover a exigência da Jornada globalmente.
- No código atual, serviços da Jornada exigem cena de 50 palavras e `/comprar` exige visita prévia ao `/pokemart`; isso explica condições de acesso, não prova do erro reportado em grupo.

## 9. Prêmios imediatos e settlement

**Imediatos e legítimos:** primeiro avistamento e shiny, captura, XP de vitórias, progressão, itens obtidos/consumidos, HP/status e localização. Não aguardar relatório para aplicá-los nem revertê-los quando um relatório é reprovado.

**Conclusão normal:** após relatório aprovado, exatamente **₽300** + **uma** rolagem:

| Bônus | Chance |
|---|---:|
| +₽200 | 45% |
| Poké Ball ×1 | 30% |
| Potion ×1 | 15% |
| +50 progressão | 10% |

Média da conclusão aprovada: **₽390**, 0,30 Ball, 0,15 Potion, 5 progressão; em três expedições: ₽1.170, 0,90 Ball, 0,45 Potion, 15 progressão. Sem XP de combate ou itens de campo nesta média.

**Relatório destaque:** opção única e auditável, com UMA rolagem extra: +₽100 60%, Ball ×1 25%, Potion ×1 10%, +25 progressão 5%. O admin marca destaque, **não escolhe** prêmio específico. Definir critérios justos de avaliação antes de implantar.

## 10. Relatório e aprovação ADM

- **1 expedição = 1 relatório externo ≥100 palavras = 1 aprovação.**
- Texto entregue fora do bot no local designado pela staff. O bot **não** coleta, interpreta ou guarda o relatório literário na V1.
- Rotom entrega resumo factual de horário, trajeto, encontros, batalhas, capturas, achados, serviços e prêmio pendente.
- Admin confere texto externo e aprova (normal/destaque) ou rejeita. Aprovação desencadeia settlement automático idempotente e auditável; usuário não precisa reivindicar com outro comando.
- Persistir id único de expedição, proprietário, estado, eventos objetivos, snapshot da recompensa, status de relatório, admin/revisão e ledger de pagamento.
- Aprovação repetida, retry/outbox replay ou múltiplos admins **não** duplicam prêmio.
- Relatórios pendentes **não** bloqueiam novas expedições se há cota semanal.

## 11. Encerramento, blackout e resgate

Encerrar voluntariamente antes do horário ou automaticamente no fim das 12h. Se time inteiro incapaz de batalhar: **blackout encerra e consome expedição**, realoca a ponto seguro **aprovado pela topologia**, executa recuperação emergencial conforme política a integrar. Sem multa adicional de dinheiro.

Preservar capturas, Pokédex, achados, Ball consumidas, XP e progressão já obtidos. **Blackout = ₽0 da conclusão, sem bônus**. Não inventar teleportes ao primeiro ponto ou perda de conquistas.

## 12. Cenários visuais coerentes

Assets pesquisados/curados com direitos adequados; não gerar fundos aleatórios. Seleção estrita:

`área → horário → superfície LAND/WATER → microhabitat → ecologia/espécie → iluminação/composição → fundos aprovados`.

Metadados por cenário: ID, área, dia/noite, superfície, microhabitat, luz, species_tags e `approved`. Várias variantes compatíveis podem ser sorteadas. Sem fallback visual incompatível; se não houver fundo confiável, mostrar Pokémon em apresentação limpa. Congelar fundo no encontro; preservar escala, posição e perspectiva. Biblioteca visual ainda não construída.

## 13. Interface Rotom + WhatsApp

Usar identidade existente: `ROTOM · EXPLORAÇÃO / VIAGEM / ENCONTRO / BATALHA / POKÉ MART / CENTRO POKÉMON`, sem criar aparência paralela.

- Comandos gerais com barra, como `/explorar`; dentro de sessão viva, números, confirmações e intenções livres **claras**.
- Interpretar `1`, `sim`, `não quero ele`, `quero voltar`, `pokebola`, `não sei`; erros de espécie como `shromish` somente com desambiguação segura.
- Sem aceitar texto ambíguo como instrução para gastar item/recurso.
- Rotom guia iniciantes, informa por que alvos estão indisponíveis sem vazar spoilers, oferece ajuda contextual e retoma fluxo.
- Evitar mensagens sucessivas para viagem, turno, encontro e captura. Preferir legenda compacta com imagem quando houver cena correta; menu só quando necessário.
- Não exigir 50 palavras em cada ação autônoma; concentrar narrativa no relatório final.

## 14. Segurança e integração

Uma expedição ativa por jogador; estado persistente após reinício; concorrência serializada por jogador/expedição; ações e rolagens com idempotência; mesmas capturas/itens/recompensas nunca entregues em dobro; encounter/batalha não são destruídos por falhas de mensageria. Sem spawn fora do pool/horário/unlocks; sem alterar políticas de Jornada indiscriminadamente. Ações administrativas auditáveis, sem efeitos reais durante QA. Separar código em PR, testes, staging sintético, canário e publicação autorizada.

Módulos a reutilizar: `World/Location`, conexões, encounter tables, `EncounterService`, Battle, Capture, Progression, TEAM/BOX, Pokédex, RotomDex, Economy, World Services/Healing, PokéMart, WhatsApp messaging/outbox, administração. A exploração é **orquestrador**, não implementação paralela.

## 15. Desenvolvimento V1.1–V1.7

1. **V1.1:** expedições/3 semanais, relógio de ação, persistência, viagem e localização.
2. **V1.2:** caça livre/direcionada, conhecimento Rotom, pesos ×3, rastros, incidentes e encounter.
3. **V1.3:** RNG e loot local, Repel se item legítimo.
4. **V1.4:** Centro e PokéMart com admissão de expedição sem mudar Jornada.
5. **V1.5:** encerramento antecipado/fim automático/derrota/resgate.
6. **V1.6:** resumo, relatório externo, aprovação admin, recompensas e ledger idempotente.
7. **V1.7:** UX, parser seguro, cenários curados, acessibilidade, testes, canário e cutover.

Não são temporadas nem lançamentos obrigatoriamente separados. Cenários podem ser desenvolvidos em paralelo, mas sem inventar conteúdo.

## 16. Rejeições explícitas

Não adotar: pontos de exploração, energia, spawn instantâneo por clique, expedições infinitas, 1 ação = 1 fase do dia, 50 palavras por ação, relatório enviado ao bot, pacote de vários relatórios, teleporte livre, NPCs roteirizados e eventos complexos na V1, crafting, limite por peso, clima complexo, locais secretos elaborados, blacklist de espécies, novas áreas vazias, espécies reservadas no pool normal e fundos visualmente incompatíveis. A primeira proposta de limite de chance direcionada a 50% foi superada por ×3 sem teto adicional.

## 17. Itens técnicos ainda a verificar

- Quais tabelas, pesos e espécies estão **realmente** ativos na release do bot local; versão do conteúdo e filtros específicos; ecologia e exceções de evento.
- Duração real das conexões Vila/Yun (45 min foi **apenas exemplo**).
- Fuso canônico e momento de reset semanal, política de primeira ação e recálculo seguro em replays.
- Repel no inventário/catálogo, concessão e duração.
- Recompensa do ruleset efetivamente executado, XP/Insígnias, durações de serviço, grade de loot por área.
- Ponto seguro e tratamento do blackout; batalha que atravessa horário limite.
- Aprovação ADM, UX de staff, critérios de destaque e ledger.
- Catálogo visual licenciado, metadados ambientais e teste móvel.
- Configuração de PvE/PvP e permissões de grupos antes do uso de comandos.
- **Não afirmar** que o relógio puro presente na branch equivale ao `/explorar` funcional.

## 18. Ordem de atendimento — outubro de 2026

1. Corrigir comandos da denúncia: `/iniciarbatalha` (narrador), `/desafiar`, `/spawn` (narrador), `/aceitar`, `/comprar`, `/pescar`; validar permissões, requisitos e runtime no ambiente correto. PR isolada de capabilities de grupos `#235`.
2. Regressão em PostgreSQL efêmero e simulator WhatsApp por papéis/estados, incluindo ausências, replays e bloqueios legítimos.
3. Implantar V1.1 e auditar canonicamente Vila/Yun; relógio inicial isolado nesta branch.
4. Construir V1.2–V1.6, depois V1.7, sem cobrar ações do usuário nem sacrificar segurança. Publicar apenas depois de QA e autorização de cutover.
