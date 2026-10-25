# Exploração Individual V1.2 — pesos de busca direcionada (Draft)

**Base:** PR #254 `2b35e974132ef7b7665b011935396168b574cd10`, não mesclada. Este arquivo documenta apenas uma regra de domínio **pura**, testável isoladamente. **Não ativa /explorar**, não cria Encounter, não consome cota ou relógio e não modifica qualquer registro.

## Regra exata (baseline canônico de 23/10/2026)

Busca livre mantém pesos originais. Busca direcionada só pode ser solicitada para espécie anteriormente vista ou capturada **pelo próprio jogador** e que permaneça mecanicamente elegível na tabela de encontro **realmente publicada** para área/horário/superfície/unlocks atuais.

Para cada linha elegível da espécie escolhida, peso efetivo = `3 × peso original`. As demais linhas são mantidas; nenhum reroll é aplicado. Depois da renormalização, uma espécie com peso agregado inicial de probabilidade `p` passa a `3p / (1 + 2p)`. Não existe teto arbitrário de 50%.

Exemplos (somente matemática, não taxas de spawn por área): `p=5%` → `13,636…%`; `p=20%` → `42,857…%`; `p=30%` → `56,25%`.

## Limites de confiança e não-spoiler

1. `prepareExpeditionEncounterWeights` só recebe linhas pré-filtradas por um provedor confiável. O provedor ainda deverá comprovar release PUBLISHED/ACTIVE, mesma área/World, horário, superfície LAND/WATER, unlocks, evento, ecologia e exclusões. Os resultados da prévia V1.1 **não** bastam para autorizar uma caça.
2. `knownSpeciesIds` deve vir de consultas de Pokédex no PostgreSQL autorizadas pelo proprietário. Jamais derivar de um nome digitado pelo jogador ou confiar num array enviado pelo WhatsApp.
3. Alvo nunca visto e alvo conhecido mas inelegível recebem a **mesma resposta não reveladora**. Não anunciar espécies, regiões ou horários secretos.
4. Pesos precisam ser inteiros positivos e totais `Number.isSafeInteger`; IDs de entrada duplicados são inválidos. Detectar overflow antes do sorteio.
5. `drawExpeditionEncounterEntry` recebe apenas RNG confiável do servidor; o WhatsApp nunca fornece rolagem. Há **uma** chamada de RNG e **um** resultado, nunca reroll gratuito.
6. A escolha retorna somente a entrada elegível; não persiste nem gera UUID de encounter ou Pokémon. O futuro orquestrador deve validar e debitar relógio/idempotência em transação, depois chamar EncounterService canônico.
7. Múltiplas formas/linhas da mesma espécie recebem peso ×3; não permitir que espécie com várias linhas crie bônus acumulado >3 por linha.
8. A exceção de busca direcionada fica fora de spawn competitivo, pesca e encontros de Jornada.

## Próxima integração obrigatória V1.2

- Criar read model `PostgresEligibleExpeditionEncounterTable` com filtro de release/área/horário/ambiente e assinatura versionada, sob o mesmo lock/transaction que World/expedição/recibo. Não usar o catálogo rascunho e não inventar condições de clima.
- Consumir contadores de Pokédex de quem está explorando; identificar espécie por UUID interno, resolver nome humano com desambiguação segura.
- Reconciliar outcomes da busca: nenhum sinal, rastros, encontro incidental, encontro direto. **Distribuição probabilística dos outcomes não foi definida por este módulo.** Não improvisar tabela só para parecer jogável.
- Implementar busca de 30 min, seguir rastros +15 min, ignorar encontro +10 min, encontros/batalhas pelo motor canônico; garantir que consultas de Rotom custem zero.
- Garantir captura, fugas, HP, evolução, XP e recompensas por regras existentes e replays transacionais; nunca XP por tentativa de captura isolada.
- Testar propriedades estatísticas com seeds determinísticas, injeções de RNG fora do intervalo, faltas de tabela, release divergente, corrida de mensagens e reinício.
- Apenas depois, integrar V1.3–V1.7, migração autorizada, backup restaurável, UAT WhatsApp e liberação explícita.

**STATUS:** alicerce matemático V1.2 implementado, busca jogável **não implementada**.


## Leitor de catálogo realmente publicado — implementação de 25/10

`src/platform/exploration/postgres-eligible-expedition-pool.ts` adiciona um adaptador transacional **somente leitura**, e `tests/db/eligible-expedition-pool.integration.test.ts` testa esse caminho em PostgreSQL descartável (com `ALLOW_DISPOSABLE_POSTGRES_TESTS=1`).

- Exige `content_release_pointers.ACTIVE`, release e ruleset **PUBLISHED** e revisões ativas de região, área, tabela, espécie e forma.
- Limita o escopo à Vila dos Arrozais e Campos de Yun, à localização persistida **do próprio jogador**, conta ACTIVE e onboarding COMPLETE.
- Exige `encounterTableSlug` explícito, com `timeOfDay` DAY/NIGHT e `surface` LAND/WATER provenientes do contexto de servidor. Não escolhe uma tabela arbitrariamente se houver várias.
- Reutiliza `parseEncounterConditions` e `encounterConditionsAllow` do Encounter canônico, inclusive unlocks requeridos/bloqueados, tempo, superfície, raridade e clima, quando explicitamente presentes.
- Lê somente Pokédex AVISTADA ou CAPTURADA *das espécies restantes no pool elegível*; em nenhuma hipótese lê Pokédex de outro treinador nem informa espécies ocultas na mensagem WhatsApp.
- Retorna os dados tipados usados por `prepareExpeditionEncounterWeights`, sem sortear, gerar Pokémon, reservar turno, consumir tempo ou persistir.
- Para a primeira ação mecânica V1.2, reutilizar `eligibleExpeditionPoolInTransaction` dentro da transação canônica **com** a guarda da release/cursor, o RNG determinístico e um recibo de ação; a interface read-only `PostgresEligibleExpeditionPoolReader` não basta para autorizar efeitos.

**Observação:** um leitor de pool real melhora a integridade da prévia, mas ainda não implementa buscar Pokémon jogavelmente. A probabilidade de aparecerem rastros/nenhum sinal/encontro direto segue sem balanceamento homologado.
