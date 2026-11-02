# Pokémon Beyond — gate operacional para atualizar o bot local e anunciar

**Estado em 01/11/2026:** **NO-GO**. Documento de preparação, não autorização de publicação. Checklist prioritária: [issue #264](https://github.com/Otiosun/sla/issues/264). Histórico de decisões: [handoff Komekko](https://docs.google.com/document/d/1DfnnIPbDPw4obRM-PjrvAySYwiKt0B6R60zrNz1l_bw/edit). UX normativa: `docs/ux/EXPLORATION_PLAYER_FLOW_UX_V4_APPROVED_20261026.md`.

## 1. Limites de execução

- **Não alterar** bot em uso (`PM2`, Baileys, sessão WhatsApp, banco vivo, migrations, deploy), não fazer merge de PR Draft e não comunicar funcionalidade como ativa sem GO explícito do proprietário.
- Trabalho em branch/teste isolado é permitido. CI com `APP_ENV=test`, `WHATSAPP_ENABLED=false` e PostgreSQL descartável **não** comprova handset WhatsApp nem compatibilidade do PostgreSQL vivo.
- Backups locais históricos e cópias efêmeras de banco **não** substituem backup externo criptografado e restauração validada.
- PRs #287 (bot legado/local), #132 (Hub) e stack de exploração #288–#302 precisam de **comparação de branches/HEAD e reconciliação** antes de criar candidato único; um PR Draft verde não representa release consolidado.

## 2. Checklist fechada por prova

- [x] Exploração V4 em candidato: deduplicação de busca, prova SENT de Outbox e transição de encontro / Pokédex em PostgreSQL 18 descartável (#298–#299).
- [x] OutboxWorker real com callback pós-SENT opt-in e reconciliação explícita após SENT (#299), sem registro no runtime live.
- [x] Proteção opt-in contra envios ambíguos e leases expirados (#300), ainda SEM habilitação homogênea em workers reais.
- [x] Prova de quote privada e dono/Encounter ACTIVE/ENGAGED em mock (#301).
- [ ] Prova da **SQL real de quote no PostgreSQL 18**, com Outbox PENDING recusado e SENT/ENGAGED aceito somente após worker; o PR #302 acrescenta essa cobertura, sujeita a CI.
- [ ] Menu realmente enviado e vinculado à mensagem externa, sessão/índices estáveis, antirreplay e autoridade do jogador por inbox, quota e estado canônicos.
- [ ] Integração efetiva CaptureService + inventário/consumo de Ball idempotente, e PvE existente, incluindo falhas, replays, concorrência e persistência. Não publicar opções vazias.
- [ ] Chances/tabelas de espécies, TRAIL, recursos e travessias aprovadas e `PUBLISHED`, sem dados ilustrativos inventados.
- [ ] Staging WhatsApp/Baileys real e isolado, receipts observáveis, filas DEAD/ambíguas com reconciliação operacional e políticas uniformes entre workers.
- [ ] UAT com jogadores/testadores autorizados em Android, iOS e Web: menu quoted reply, captura, batalha, apresentação/imagem, `[Ler mais]` (não enviar marcador literal), mensagens longas, segurança e fluxos de falha.
- [ ] Congelamento de SHA final: documentação do conjunto de PRs/artefatos, migrações numeradas, `typecheck`, lint/format, builds e testes full-stack em candidato consolidado; revisão do Hub #132 e permissões #255/#287.
- [ ] Cópia **externa criptografada** do projeto e banco vigente + sessão Baileys, integridade verificável, restauração exercitada fora de produção e plano de rollback aprovado.
- [ ] Janela de manutenção e comparação pré/pós versão, verificação do banco, monitoring de mensagens, Pokédex, encounters, capture, PvE e Hub; GO explícito do proprietário.

## 3. Sequência do cutover local (SOMENTE depois de todos os gates + GO)

1. Em um **workspace separado**, congelar SHA/lockfile/identidade das branches; não sobrescrever a árvore suja ou `detached HEAD` conhecida de `C:\\Users\\natan\\Documents\\meu-bot-rpg`. Auditar diferenças do bot ativo e da release candidata; resolver conflitos.
2. Fazer e verificar **backup externo criptografado** dos diretórios/artefatos necessários, arquivos de sessão e banco. Registrar local seguro fora do repo, hash e prova de restauração. Não imprimir nem subir credenciais/backup.
3. Executar testes, builds e auditoria de migrações no **staging clonado com banco descartável**. Nunca aplicar SQL de `db/drafts/` diretamente ao banco ativo. Numerar e testar migrações reversíveis/recuperáveis.
4. Fazer UAT real de WhatsApp isolado + regressão de XP, Pokedex, captura, PvE, permissões e rotas antigas. Fechar qualquer issue P0/P1 antes da publicação.
5. Registrar autorização GO e janela; então, e só então, usar procedimento de instalação local aprovado (com parada segura, migração, reinício, monitoramento e rollback). Registrar versão implantada e comprovação em logs.
6. Anunciar **apenas os recursos efetivamente instalados e validados**, depois de smoke test pós-cutover e aceite do responsável. Caso haja regressão, pausar anúncio, reverter com backup e reabrir NO-GO.

## 4. Mensagem preparada, não publicar agora

**Pré-anúncio interno (após GO, editar conforme recursos realmente entregues):**

> Atualização Pokémon Beyond: uma nova versão foi implantada e validada. Confira os comandos e recursos confirmados no changelog oficial. Se algum comportamento parecer incorreto, avise a equipe com o comando e o horário para investigarmos.

**Proibido antes do GO:** prometer exploração jogável, captura, PvE, imagens, bônus, data/hora de abertura ou dizer que a versão está 100% instalada enquanto qualquer gate acima estiver aberto.

## 5. Dificuldades e riscos preservados

- `adapter.send()` pode aceitar a mensagem mesmo que a chamada rejeite; a quarentena opt-in evita retry automático em staging, porém **sem receipts externos não identifica entregue versus perdido**. DEAD requer resolução humana/operacional e pode segurar mensagens.
- A prova `Outbox SENT` é **persistência local**, não confirmação de leitura no telefone. O callback pós-SENT não torna WhatsApp exactly-once; não ligar o worker staging à sessão real por engano.
- O resolver de quote #301 é **read-only** e ainda não valida sozinho o jogador a partir de uma identidade WhatsApp autenticada: esse vínculo precisa vir do serviço de identidade confiável da rota antes de chamar o resolvedor.
- Sem rollback comprovado e sem UAT, manter **NO-GO** independentemente de CI verde.

**Atualizar este documento e a issue #264 com SHA, CI, obstáculos e leitura de volta a cada novo bloco.**
