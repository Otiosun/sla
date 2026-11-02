# Pokémon Beyond — Gate de integração sombreada (UX #255 ↔ Exploração #247–#254)

**Data:** 2026-10-25. **Natureza:** plano de integração e verificação; **não** habilita /explorar, não migra banco, não publica nada.

## Versões auditadas

- UX/permissões, PR #255: `4d11427f77d697ce18b2bb527c4dc7914492db3a` (gate completo 16/16 antes das alterações posteriores nesta Draft).
- Pilha de exploração (PRs Draft, não mescladas): #247 `175f1e1f`, #248 `1d94448b`, #249 `9cd03696`, #250 `86714b46`, #251 `5cbcfc80`, #252 `7cccacba`, #253 `a2d0cba`, #254 `2b35e974`.
- Verificado por compare GitHub: #254 e #255 **divergiram**; #255 tinha 115 commits exclusivos e #254 tinha 68 commits exclusivos no momento da auditoria. Nenhum SHA de outra PR foi mesclado aqui.
- Maior ponto de integração comum: `src/runtime/compose-whatsapp-runtime.ts`. As duas versões inserem rotas em um único `MessageRouter` com `RuntimeCommandPolicyGate`. Não copiar todo o arquivo de uma branch sobre a outra.

## Contrato de segurança por operação

| Operação | Exigência | Efeito de jogo |
|---|---|---|
| `/menu`, `/perfil`, `/equipe`, `/colecao`, `/box`, `/pokemon`, `/inventario`, `/pokedex`, `/onde` | Leitura, sem bloqueio genérico por suspensão; privacidade e recepção preservadas | Nenhum |
| `/equipe colocar/guardar`, `/ir` | ACTIVE + preparo mecânico; auditoria antes do handler | Escrita canônica |
| Cadastro `/registrar`, `/regiao`, `/starter`, `/concluir` | PENDING/PROVISIONING/ACTIVE; negar SUSPENDED; não exigir COMPLETE | Apenas estados legítimos de ingresso |
| `/explorar status`, `/explorar retomar` da #254 | ACTIVE + preparo mecânico + cadastro completo; somente preview em opt-in explicitamente habilitado | **Nenhum** |
| Futuras ações autônomas | ACTIVE + COMPLETE + validação de release/area/rota/encounter + sessão e lock transacional | Somente após V1.1–V1.7 homologadas |

## Ordem de integração sem mesclar automaticamente

1. Congelar SHAs e confirmar a base da sequência #247 → #254. Reproduzir os testes específicos de cada PR em PostgreSQL descartável, sem confiar apenas nas suas CIs históricas.
2. Criar branch **isolada de integração** a partir do HEAD mais recente da UX e aplicar a pilha de exploração com revisão de conflito arquivo por arquivo. Esta instrução exige autorização para executar merges; **não foi executada neste PR**.
3. Na composição do runtime, preservar a política central da #255, a ordem de rotas e a guarda `soloExplorationPreview?.enabled === true` da #254. A ausência de opt-in não pode registrar `/explorar` nem oferecer ação mecânica implícita.
4. Confirmar com cenários: jogador novo, PENDING, PROVISIONING, ACTIVE incompleto, ACTIVE completo, SUSPENDED, ADMIN, mensagens embutidas, retransmissões, grupos e privado. Credenciais do Hub enviadas **somente em privado**.
5. Garantir que `/onde` de Jornada não aciona relógio da expedição; `/explorar status` não consome cota, move, cria Encounter ou muda World.
6. Rodar suite PostgreSQL de concorrência/rollback/replay do `PostgresExpeditionFirstAction` com escopo real da transação World. Validar `current_area_id` + origem imutável, inclusive após restart.
7. **Não** promover `db/drafts/solo_exploration_v1_schema.sql` para migrações até reconcile da cadeia oficial: o maior arquivo numerado auditado foi `0078_premium_luck_capture_and_universal_xp.sql`. Revisar roles, índices, rollback, restore e deploy com responsáveis.
8. Publicar apenas após gate integral no SHA de integração, restore comprovado, UAT WhatsApp real e aprovação explícita. Não tocar no bot do Windows durante esta integração sombreada.

## Critérios V1.1–V1.7 (o que falta de verdade)

- **V1.1**: lock de usuário + World, local e release ACTIVE/PUBLISHED, duração **real** de conexão (não 30/45 min fictícios), cota semanal (3), relógio de 12h, replay e rollback em um commit. O draft já cobre partes da transação mas não resolve a autorização de conteúdo para jogar.
- **V1.2**: EncounterService para busca livre/direcionada, apenas espécies conhecidas para alvo, peso ×3 sem teto artificial, espécie realmente elegível em tabela publicada, resultados de rastros e encontro incidental.
- **V1.3**: loot por catálogo/área e RNG atômico com inventário, sem reembolso fictício por retries; Repel só se item/efeito de catálogo aprovado.
- **V1.4**: Centro/PokéMart dentro de expedição com World + serviço e cobrança de tempo apenas em ações válidas; não alterar regra de 50 palavras da Jornada.
- **V1.5**: limite do relógio, saída voluntária e blackout com ponto seguro conforme topologia, sem teleporte arbitrário nem perda de captura/XP.
- **V1.6**: relatório externo ≥100 palavras, revisão/admin auditável, settlement com prêmio normal e extra determinístico, idempotência multi-admin e ledger econômico.
- **V1.7**: controle de intenção ambígua e UX Rotom, direito a assets aprovados, regressões de acessibilidade, UAT real, plano de corte e retorno.

## Gate mínimo de captura e XP integrados

- Vitória PvE via worker elegível WILD/NPC, sem prêmio de vitória por captura, fuga ou PVP; XP de Pokémon conforme ruleset pinado e ajuste premium apenas no XP efetivamente ganho.
- Cada tentativa de captura consome uma Ball canonicamente e cria **no máximo uma** instância com IVs, shiny, natureza, habilidade, golpes e Pokédex preservados; replays não cobram de novo.
- Recursos/caça/settlement da expedição não podem emitir eventos de recompensa de batalha fictícios; XP/itens legítimos se aplicam de imediato, sem duplicidade no relatório.
- Testes com dois jogadores, concorrência, falha após persistir e falha do outbox; IDs internos, hashes e RNG nunca devem aparecer nas mensagens de WhatsApp.

## Pendências bloqueantes para decisão do produto

1. Duração verdadeira aprovada da ligação Vila dos Arrozais ↔ Campos de Yun, no catálogo ativo.
2. Timezone canônico de reset semanal; período diurno/noturno de 12 horas internas versus horário de parede.
3. Política de encounter tables realmente publicadas no conteúdo em produção/canário e espécies excluídas.
4. Catálogos de recursos/Repel, blackout, recompensa/relatório e ativos visuais licenciados.
5. Migração numerada, backup **restaurado em teste**, canário, UAT e aprovação final.

**STATUS: integração planejada, NÃO executada.** Nenhum comando de exploração jogável foi aberto e nenhuma PR independente foi mesclada.
