# RPG Pokémon — Recepção, Ficha, Aprovação e Grupos — Design v1

Data: 2026-09-01
Status: DESIGN APROVADO EM CHAT, AGUARDANDO REVISÃO DA SPEC
Repo: `Otiosun/sla`
Base canônica validada antes desta spec: `main@c5184ac4e0e1f712703899cd0625025bc46412f7`
Escopo: bot WhatsApp. Futuro site híbrido deverá consumir as mesmas operações de domínio, sem criar uma segunda lógica de ficha/aprovação.

## 1. Objetivo

Criar uma camada formal de entrada no RPG por WhatsApp com:

- grupo de Recepção como porta oficial de cadastro;
- ficha criada totalmente no WhatsApp no v1;
- dois modos de criação: guiado ou ficha completa;
- edição livre até confirmação explícita;
- submissão versionada e imutável para análise;
- revisão humana por ADMs;
- aprovação pelo WhatsApp e, no futuro, pela Central ADM usando a mesma operação de backend;
- liberação do jogador somente depois de provisionamento mecânico completo;
- grupos configuráveis por JID/chatRef e capacidades, sem hardcode por nome;
- comandos liberados por combinação de ator, estado do jogador, capacidade do grupo e estado mecânico;
- menções reais aos ADMs responsáveis pela Recepção;
- Inbox/Outbox, idempotência, concorrência, auditoria e retry reaproveitando a infraestrutura existente.

A Recepção não substitui o núcleo mecânico atual de Player/Starter/World. Ela fica antes dele.

## 2. Decisões canônicas do produto

### 2.1 Canal

- V1: criação de ficha somente no WhatsApp.
- Futuro: modelo híbrido WhatsApp + site.
- Site futuro não ganha uma segunda fonte de verdade; ele chama as mesmas operações de Registration/Review.

### 2.2 Modos de criação

O jogador escolhe:

1. guiado passo a passo;
2. preencher a ficha completa de uma vez.

Ambos editam o mesmo modelo de rascunho e o jogador pode alternar entre modos sem reiniciar.

### 2.3 Persistência do rascunho

Decisão explícita: respostas normais durante a edição NÃO são consideradas um salvamento persistente solicitado pelo jogador.

- mudanças durante uma sessão ativa podem ficar somente na sessão de edição;
- `$salvar` persiste o rascunho;
- `$confirmar sim` também persiste o estado atual e cria a revisão submetida atomicamente;
- antes de `$salvar`, reinício do processo pode perder alterações não salvas;
- o bot deve sinalizar quando existem alterações não salvas.

### 2.4 Edição e confirmação

- antes da submissão, todos os campos podem ser alterados quantas vezes o jogador quiser;
- `$confirmar` apenas valida e mostra a ficha inteira para revisão;
- a confirmação definitiva exige uma segunda ação explícita, por exemplo `$confirmar sim`;
- nada mecânico é concedido antes desta confirmação e da aprovação administrativa;
- se o jogador editar enquanto a ficha está em análise, a revisão submetida é retirada e uma nova edição nasce a partir dela;
- se o ADM pedir ajustes, a ficha volta para edição preservando tudo que já estava preenchido.

### 2.5 Um jogador, um personagem

No v1:

- uma identidade WhatsApp vinculada a um jogador;
- um personagem ativo por jogador;
- multi-personagem fica fora de escopo.

### 2.6 Região

- a região inicial do RPG é somente Zhoulia;
- o jogador não precisa escolher a região no v1;
- o sistema armazena o identificador real da região, não a string `Zhoulia` hardcoded como regra permanente;
- a arquitetura não deve impedir múltiplas regiões futuras.

### 2.7 Campos da ficha v1

Campos básicos:

- nome;
- idade;
- gênero/pronomes;
- aparência;
- personalidade;
- história/resumo;
- Pokémon inicial pretendido;
- região de origem, preenchida automaticamente como Zhoulia.

Não entram no v1 campos extras como profissão, classe, altura, peso, signo, aniversário ou listas longas de características sem necessidade mecânica real.

### 2.8 Inicial

A escolha do inicial durante a ficha é somente uma intenção congelável.

- trocar o inicial antes da confirmação é permitido;
- `$starter` não deve mais significar concessão mecânica durante a criação da ficha;
- a instância real do Pokémon só é criada depois da aprovação administrativa e durante o provisionamento;
- a espécie/formulário deve ser validada contra as opções de starter ativas da release/região correspondente.

### 2.9 Revisão administrativa

Ações oficiais:

- `$aprovar`;
- `$ajustes`;
- `$rejeitar`;
- `$verficha` para consulta.

O caminho preferencial é responder diretamente à mensagem da ficha. Como alternativa, comandos podem identificar o jogador explicitamente.

No WhatsApp:

- comentários podem ser manuais e livres;
- comentário não é autoridade mecânica;
- `$ajustes` muda estado mesmo sem comentário embutido;
- `$rejeitar` não exige texto obrigatório no comando v1.

Na Central ADM futura:

- `Aprovar` chama a mesma operação;
- `Pedir alterações` pode aceitar texto para o bot retransmitir;
- `Rejeitar` chama a mesma operação;
- a Central nunca altera a DB por caminho paralelo.

### 2.10 Pós-aprovação

Decisão atual: comportamento A.

Após aprovação e provisionamento concluído:

- o bot anuncia na Recepção;
- o jogador é liberado mecanicamente;
- o bot não auto-adiciona o jogador a outros grupos;
- o bot não é obrigado a enviar pacote de links em PV;
- acesso a outros grupos ocorre pela organização normal do RPG.

## 3. Separação de domínios

O sistema deve separar três conceitos que não são equivalentes.

### 3.1 Registration

Representa ficha humana e revisão administrativa.

Responsabilidades:

- rascunho;
- validação da ficha;
- snapshots imutáveis;
- submit;
- withdraw;
- request changes;
- approve/reject;
- histórico da análise.

### 3.2 Player Onboarding mecânico existente

Permanece com a state machine atual:

`NEW -> PROFILE_CREATED -> REGION_SELECTED -> STARTER_PENDING -> STARTER_GRANTED -> COMPLETE`

Registration não substitui essa máquina.

O onboarding mecânico é executado após aprovação para materializar o personagem usando os serviços já existentes.

### 3.3 Player Access

Representa se o jogador pode utilizar o RPG.

Estados v1:

- `PENDING`;
- `PROVISIONING`;
- `ACTIVE`;
- `SUSPENDED`.

Registration aprovada não implica `ACTIVE` até que o provisionamento complete todos os invariantes.

## 4. Módulos propostos

### 4.1 `src/modules/registration/`

Responsável por:

- draft;
- schema/validation;
- revision snapshots;
- submit/withdraw;
- admin review;
- player access;
- orchestration de provisioning pós-aprovação.

Não deve reimplementar Profile, Starter ou World.

### 4.2 `src/modules/community/`

Responsável por:

- registry de grupos;
- papel do grupo;
- capabilities do grupo;
- contexto do chat;
- Recepção;
- presença/join/leave;
- responsáveis administrativos da Recepção.

### 4.3 `src/modules/messaging/`

Permanece como transporte:

- Inbox;
- idempotência;
- rate limits;
- router;
- Outbox;
- retries;
- adapters.

Não vira a fonte da regra de Registration.

### 4.4 `src/modules/admin/`

Permanece como autoridade de operações administrativas.

Novas operações de review/access/community entram no mesmo registry/capability system existente.

## 5. Modelo de dados v1

Nomes abaixo são de design; a implementação pode ajustar naming para seguir convenções já existentes, sem mudar invariantes.

### 5.1 `registration_drafts`

Um rascunho persistido por jogador.

Campos mínimos:

- `player_id` PK/FK;
- `trainer_name`;
- `age`;
- `gender_pronouns`;
- `appearance`;
- `personality`;
- `backstory`;
- `starter_form_id`;
- `region_id`;
- `schema_version`;
- `revision`;
- `created_at`;
- `updated_at`.

Invariantes:

- um draft persistido por jogador;
- `region_id` no v1 aponta para Zhoulia ativa;
- `starter_form_id` só é considerado válido se estiver entre as opções de starter da release/região aplicável;
- save usa expected revision para impedir overwrite silencioso.

### 5.2 `registration_revisions`

Snapshot imutável submetido à administração.

Campos mínimos:

- `id` UUID PK;
- `player_id`;
- `sequence_no`;
- `status`;
- `schema_version`;
- `snapshot_json`;
- `revision`;
- `submitted_at`;
- `decided_at`;
- `decided_by_admin_principal_id` nullable;
- `created_at`.

Constraint:

- `UNIQUE(player_id, sequence_no)`.

Estados:

- `SUBMITTED`;
- `CHANGES_REQUESTED`;
- `APPROVED`;
- `REJECTED`;
- `WITHDRAWN`.

O snapshot é imutável. Alterar ficha gera novo draft/revisão; nunca edita uma revisão já enviada.

### 5.3 `player_access`

Campos mínimos:

- `player_id` PK;
- `status`;
- `revision`;
- `suspended_reason` nullable;
- `suspended_by` nullable;
- `updated_at`.

Estados:

- `PENDING`;
- `PROVISIONING`;
- `ACTIVE`;
- `SUSPENDED`.

Suspensão não apaga ficha, starter, inventário, mapa ou histórico.

### 5.4 `community_groups`

Campos mínimos:

- `id` UUID PK;
- `provider`;
- `chat_ref`;
- `role`;
- `display_name`;
- `status`;
- `revision`;
- `created_at`;
- `retired_at` nullable.

Constraint:

- `UNIQUE(provider, chat_ref)`.

Roles humanos iniciais:

- `RECEPTION`;
- `GAME`;
- `PVP`;
- `COMMUNITY`;
- `STAFF`.

Autorização real usa capabilities, não apenas role.

### 5.5 `community_group_capabilities`

Campos mínimos:

- `group_id`;
- `capability_key`.

Capabilities iniciais sugeridas:

- `onboarding`;
- `player.basic`;
- `admin.review`;
- `world`;
- `pve`;
- `pvp`;
- `admin`;
- `observability`.

Grupo desconhecido não possui capabilities e falha fechado.

### 5.6 `reception_staff_assignments`

Campos mínimos:

- `group_id`;
- `admin_principal_id`;
- `active`;
- `created_at`.

Estar aqui não concede autoridade. Na hora da ação, o AdminPrincipal ainda precisa da capability exigida.

Usado também para descobrir quem deve ser mencionado em uma nova submissão.

### 5.7 `community_member_presence`

Campos mínimos:

- `group_id`;
- `player_id`;
- `presence_generation`;
- `first_seen_at`;
- `last_seen_at`;
- `last_joined_at` nullable;
- `last_left_at` nullable;
- `last_welcome_at` nullable.

Presença nunca é autoridade para deletar cadastro ou suspender acesso.

### 5.8 Referência de mensagem de revisão

O sistema precisa mapear uma mensagem publicada no WhatsApp para `registration_revision_id` para que replies administrativos resolvam a revisão correta.

Preferência:

- reaproveitar metadados/resultado do Outbox existente se ele suportar a associação sem acoplamento ruim.

Fallback aceitável:

- uma pequena tabela `registration_message_refs(provider, external_message_id, review_id, kind)`.

A decisão final depende da leitura completa do adapter/repository de Outbox durante o plano de implementação.

## 6. Sessão de edição efêmera

O modo guiado precisa aceitar mensagens que não começam com `$` sem transformar o router inteiro num listener genérico.

Design:

1. Messaging recebe a mensagem e preserva Inbox/rate-limit/idempotência atuais.
2. Antes do command router, um `RegistrationConversationResolver` verifica se:
   - o chat possui capability `onboarding`;
   - o jogador possui sessão ativa de edição;
   - a mensagem é elegível para o passo atual.
3. Se sim, a sessão consome a resposta e atualiza apenas `workingValues` efêmeros.
4. Se não, a mensagem segue para o router existente.

A sessão contém no mínimo:

- `playerId`;
- `mode: GUIDED | FULL`;
- `currentField`;
- `workingValues`;
- `dirty`;
- `lastActivityAt`.

Mensagens normais fora de uma sessão ativa não devem ser interpretadas como ficha.

## 7. Comandos do jogador

Comandos v1:

- `$registrar` — inicia/retoma criação;
- `$continuar` — mostra estado e próximo passo;
- `$ficha` — mostra ficha atual;
- `$salvar` — persiste sessão atual como draft;
- `$editar` — abre edição de draft/revisão elegível;
- `$modo` — alterna guiado/completo;
- `$confirmar` — valida e mostra preview integral;
- `$confirmar sim` — salva + congela + submete.

Semântica importante:

- `$registrar` em jogador `ACTIVE` não cria nova ficha;
- `$editar` em `SUBMITTED` exige confirmação da retirada antes de marcar a revisão `WITHDRAWN`;
- `$confirmar sim` deve ser idempotente;
- parser da ficha completa é tolerante a espaços, capitalização e pequenas variações de layout, mas não pode inferir silenciosamente valores ambíguos;
- erros mostram apenas os campos inválidos/ausentes e preservam os valores válidos.

## 8. Comandos administrativos

Comandos v1:

- `$aprovar`;
- `$ajustes`;
- `$rejeitar`;
- `$verficha`.

Caminho preferencial: reply na mensagem da ficha.

Resolução do reply:

`replyToExternalMessageId -> registration_revision_id -> current review`

Regras:

- revisão antiga/withdrawn não pode ser aprovada;
- expected revision obrigatório para mutações de decisão;
- corrida entre ADMs: primeiro commit válido vence; o segundo recebe conflito explícito;
- comandos só funcionam em grupo com capability `admin.review` e para AdminPrincipal com a capability administrativa necessária.

## 9. Admin capabilities

Novas capabilities sugeridas:

- `player.registration.read`;
- `player.registration.request_changes`;
- `player.registration.approve`;
- `player.registration.reject`;
- `player.registration.reopen`;
- `player.access.suspend`;
- `player.access.restore`;
- `community.group.manage`;
- `community.reception.staff.manage`.

Roles são pacotes de capabilities, não checks hardcoded.

Roles iniciais sugeridos:

- `RECEPTION_MOD`;
- `ADMIN`;
- `MASTER_ADMIN`.

Master possui amplo poder, mas não bypassa validação, idempotência, auditoria ou políticas da operação.

Ser administrador do grupo no WhatsApp não concede autoridade administrativa do RPG.

## 10. Group Registry e Command Policy

Cada mensagem resolve:

`chatRef -> CommunityGroup -> capabilities`

O command policy combina:

- identidade do ator;
- PlayerAccess;
- capabilities do grupo;
- Admin capability quando aplicável;
- estado mecânico exigido pela ação.

Forma conceitual:

`ALLOW = actorAllowed && playerAccessAllowed && groupCapabilityAllowed && mechanicalStateAllowed`

Exemplos:

- `$registrar`: grupo `onboarding`, jogador não `ACTIVE`;
- `$aprovar`: grupo `admin.review`, ator com `player.registration.approve`;
- `$ir`: grupo `world`, jogador `ACTIVE`, invariantes mecânicos de world válidos;
- PVP futuro: grupo `pvp`, jogador `ACTIVE` e regras do FLOW/PVP válidas.

Grupo desconhecido falha fechado.

Renomear um grupo no WhatsApp não afeta autorização porque a identidade usa `chatRef`/JID.

Múltiplos grupos com a mesma role/capabilities são permitidos.

## 11. Recepção viva

Primeira fatia segura:

- boas-vindas por primeira interação elegível no grupo de Recepção.

Fatia posterior e isolada:

- suporte ao evento Baileys `group-participants.update` para join/leave real.

Não misturar a primeira implementação do domínio com alteração crítica no adapter Baileys.

Mensagem de recepção depende do estado real:

- sem cadastro: orientar `$registrar`;
- draft existente: orientar `$continuar`/`$ficha`;
- `SUBMITTED`: informar que está em análise;
- `CHANGES_REQUESTED`: orientar `$editar`;
- `APPROVED` mas provisionando: informar que a aprovação já ocorreu e a liberação está sendo concluída;
- `ACTIVE`: não reiniciar onboarding; no máximo welcome de retorno;
- `REJECTED`: informar estado sem recriar automaticamente.

Sair e voltar do grupo não apaga nada.

Remoção do grupo não equivale a suspensão ou banimento.

Troca de número não é inferida automaticamente; exige rebind administrativo auditado.

## 12. Menções reais aos ADMs

Ao submeter:

1. resolver a Recepção atual;
2. listar `reception_staff_assignments` ativos;
3. filtrar AdminPrincipals ainda ativos e com capability de review;
4. construir mensagem com `mentions` reais no payload do canal;
5. persistir via Outbox.

Se não houver staff válido:

- a ficha continua `SUBMITTED`;
- registrar condição operacional observável;
- não desfazer a submissão.

Plantão/ON_DUTY fica fora de escopo v1.

## 13. Fluxo de revisão

### 13.1 Submit

`draft/session -> validate -> snapshot -> SUBMITTED -> outbox notify admins`

O commit da revisão e o registro da saída devem obedecer o padrão transacional possível no repository correspondente.

Falha no WhatsApp não desfaz `SUBMITTED`.

### 13.2 Request changes

`SUBMITTED -> CHANGES_REQUESTED`

Depois `$editar` cria sessão/draft a partir do snapshot anterior.

### 13.3 Withdraw pelo jogador

`SUBMITTED -> WITHDRAWN`

Depois abre nova edição baseada no snapshot retirado.

### 13.4 Reject

`SUBMITTED -> REJECTED`

Nada mecânico é criado.

### 13.5 Approve

`SUBMITTED -> APPROVED`

Depois:

`PlayerAccess PENDING -> PROVISIONING`

A aprovação administrativa não pode declarar o jogador `ACTIVE` antes do provisionamento completo.

## 14. Provisionamento pós-aprovação

`PlayerProvisioningService` orquestra serviços existentes. Ele não replica suas regras.

Sequência conceitual:

1. garantir player foundation existente;
2. garantir perfil mecânico com nome/locale aplicáveis;
3. garantir região Zhoulia via `PlayerRegistrationService`;
4. garantir estado `STARTER_PENDING` via `PlayerStarterService.prepareStarterSelection`;
5. validar que o starter aprovado ainda corresponde a uma opção válida da release pinada;
6. conceder o starter aprovado com `PlayerStarterService.grantStarter`;
7. concluir onboarding com `completeOnboarding`;
8. garantir localização inicial via `WorldService.ensureInitialLocation`;
9. verificar invariantes finais;
10. mudar `PlayerAccess PROVISIONING -> ACTIVE`;
11. enfileirar anúncio de liberação na Recepção.

O provisionamento é resumível e idempotente.

Falha em qualquer etapa deixa `PROVISIONING` e permite retry.

Nunca deve existir `ACTIVE` com provisionamento parcial.

Retry depois de starter criado não pode criar outro Pokémon; deve usar as garantias de replay/idempotência do serviço atual.

## 15. Invariantes finais para `ACTIVE`

Antes de `ACTIVE`, verificar pelo menos:

- RegistrationRevision atual `APPROVED`;
- PlayerAccess atual `PROVISIONING`;
- perfil mecânico existente;
- região de origem configurada;
- starter grant durável existente e compatível com a revisão aprovada;
- onboarding mecânico `COMPLETE`;
- localização inicial existente;
- player status mecânico compatível com gameplay.

Se algum invariável falhar, acesso não vira `ACTIVE`.

## 16. Outbox e autoridade

Regra central:

**Banco/domínio é autoridade; WhatsApp é transporte.**

Consequências:

- falha ao avisar ADMs não desfaz submissão;
- falha ao anunciar aprovação não desfaz `ACTIVE`;
- mensagens pendentes retry via Outbox existente;
- mesmo inbound replayado não pode duplicar revisão, decisão, starter ou acesso;
- nenhuma decisão de domínio depende de "a mensagem apareceu no grupo".

## 17. Concorrência e idempotência

Obrigatório:

- expected revision em updates sensíveis;
- idempotency key por operação;
- replay seguro de `$confirmar sim`;
- replay seguro de `$aprovar`;
- revisão obsoleta não pode receber decisão;
- primeiro ADM válido que grava a transição vence;
- segundo recebe conflito, não sobrescreve;
- provisioning deve tolerar restart entre quaisquer etapas.

## 18. Auditoria

Ações administrativas relevantes registram:

- AdminPrincipal;
- operação;
- target player/review/group;
- canal de origem (`WHATSAPP`, futuro `CONTROL_CENTER`);
- before/after relevante;
- expected revision;
- operation/correlation/idempotency IDs;
- timestamp;
- resultado aplicado/conflito/falha.

Novas mutações devem integrar o módulo admin/audit existente, não criar log solto paralelo.

## 19. Central ADM futura

A Central é outro cliente das mesmas operações.

Exemplo:

`Botão Aprovar -> player.registration.approve -> RegistrationReviewService -> Audit -> Provisioning -> Outbox -> WhatsApp`

A Central não escreve diretamente em `registration_revisions` ou `player_access`.

## 20. Ordem de implementação

Toda slice começa com RED e segue TDD.

### R1 — Registration puro

- draft;
- schema;
- validation;
- immutable revision;
- submit;
- withdraw;
- request changes;
- approve/reject.

Sem WhatsApp.

### R2 — PlayerAccess + provisioning

- PENDING/PROVISIONING/ACTIVE/SUSPENDED;
- orchestration dos serviços atuais;
- retry em cada boundary;
- invariantes finais.

### R3 — Community Groups

- registry;
- roles;
- capabilities;
- unknown group fail closed;
- retire/rebind.

### R4 — Command Policy

Aplicar primeiro em um comando de cada classe:

- `$registrar`;
- `$aprovar`;
- `$ir`.

Depois expandir.

### R5 — WhatsApp Registration UX

- `$registrar`;
- guided/full;
- session resolver;
- `$salvar`;
- `$ficha`;
- `$editar`;
- `$modo`;
- `$continuar`;
- `$confirmar`;
- `$confirmar sim`.

### R6 — Admin Review WhatsApp

- reply mapping;
- `$aprovar`;
- `$ajustes`;
- `$rejeitar`;
- `$verficha`;
- menções reais.

### R7 — Recepção viva

Primeiro:

- first-interaction welcome/state-aware UX.

Depois, slice isolada:

- group participant join/leave events.

### R8 — Central ADM

Fora desta primeira implementação. Integra quando as operações backend estiverem maduras.

## 21. Matriz mínima de testes

Obrigatório cobrir:

- trocar starter várias vezes antes da confirmação;
- resposta normal não persistir sem `$salvar`;
- `$salvar` persistir corretamente;
- guided <-> full preservar sessão;
- parser tolerar pequenas variações;
- parser rejeitar ambiguidade sem inventar valor;
- confirmação inválida não gerar revisão;
- `$confirmar sim` gerar uma única revisão;
- replay da mesma mensagem não duplicar revisão;
- editar durante análise retirar revisão antiga;
- nova submissão gerar novo `sequence_no`;
- ADM tentar decidir revisão antiga falhar;
- dois ADMs concorrentes terem exatamente um vencedor;
- `$aprovar` duplicado ser idempotente;
- request changes preservar dados para nova edição;
- rejeição não criar starter/localização;
- provisioning cair antes do starter e recuperar;
- cair depois do starter e não duplicar Pokémon;
- cair depois de onboarding complete e recuperar localização;
- `ACTIVE` somente após todos invariantes;
- suspensão não apagar nenhum dado mecânico;
- restore não reprovisionar;
- `$ir` na Recepção ser negado;
- `$ir` em grupo `world` com player `ACTIVE` ser permitido;
- player não aprovado em grupo `world` ser negado;
- ADM válido em grupo sem `admin.review` ser negado;
- não-ADM em Recepção ser negado em `$aprovar`;
- grupo desconhecido falhar fechado;
- rename do grupo não afetar policy;
- múltiplas Recepcões funcionarem por binding/capability;
- falha ao notificar ADMs manter `SUBMITTED`;
- falha no anúncio final manter `ACTIVE`;
- restart preservar todos os estados duráveis;
- sair/voltar do grupo não reiniciar ficha;
- player `ACTIVE` voltar e não receber tutorial de novato;
- reply para mensagem de revisão antiga ser detectado como obsoleto;
- zero staff configurado não perder submissão.

## 22. Smoke ponta a ponta obrigatório

Cenário real de staging:

1. identidade nova aparece na Recepção;
2. `$registrar`;
3. escolher modo guiado;
4. preencher parte dos campos;
5. `$salvar`;
6. retomar;
7. trocar para modo completo;
8. alterar starter;
9. `$confirmar`;
10. `$confirmar sim`;
11. revisão `SUBMITTED` única;
12. ADMs responsáveis recebem menção real;
13. ADM responde `$ajustes`;
14. jogador edita sem perder dados;
15. reenviar como revisão seguinte;
16. ADM responde `$aprovar`;
17. access `PROVISIONING`;
18. perfil/region/starter/onboarding/localização materializados;
19. access `ACTIVE`;
20. anúncio enviado à Recepção;
21. comando `world` bloqueado na Recepção;
22. o mesmo comando funciona em grupo com capability `world`.

Recepção v1 não é considerada pronta sem esse smoke.

## 23. Fora de escopo v1

Explicitamente não implementar agora:

- criação de ficha pelo site;
- auto-add em grupos;
- pacote automático de links pós-aprovação;
- plantão/ON_DUTY de ADM;
- múltiplos personagens;
- múltiplas regiões de escolha;
- IA avaliando ficha;
- OCR;
- migração automática de identidade entre números;
- banimento permanente como estado separado de suspensão;
- refatorações sem relação direta com Registration/Community.

## 24. Compatibilidade com o código atual

Este design deve preservar:

- `PlayerRegistrationService` como autoridade de perfil/região mecânicos;
- `PlayerStarterService` como autoridade de starter e conclusão do onboarding;
- `WorldService` como autoridade de localização;
- state machine atual de onboarding mecânico;
- Messaging Inbox/Outbox e rate limits;
- AdminOperationRegistry/capability model/audit;
- gates de gameplay existentes.

A implementação não deve transformar a ficha humana em substituta do agregado mecânico de Player.

## 25. Critérios de aceitação do design

A implementação derivada desta spec só pode ser considerada correta se:

- nenhum dado mecânico definitivo nascer antes da aprovação;
- jogador puder editar livremente antes da confirmação;
- a confirmação produzir snapshot imutável;
- ADM e futura Central usarem a mesma operação de backend;
- nenhum JID crítico estiver hardcoded nos handlers;
- grupo desconhecido falhar fechado;
- falha de WhatsApp não desfizer estado de domínio;
- concorrência administrativa não sobrescrever decisões;
- retry de provisioning não duplicar starter;
- `ACTIVE` só ocorrer com onboarding/localização/starter consistentes;
- o sistema continuar extensível para site híbrido sem duplicação de regra.

## 26. Pontos deliberadamente deixados para a fase de plano

Não são dúvidas de produto; são decisões de implementação que exigem leitura localizada do código e testes RED:

- caminho exato das migrations/tabelas conforme convenções atuais;
- se `player_access` deve ser tabela própria ou projeção integrada a uma estrutura existente, preservando os quatro estados e seus invariantes;
- mecanismo concreto de sessão efêmera no worker singleton;
- local exato do `RegistrationConversationResolver` no pipeline sem quebrar o router atual;
- forma mais limpa de persistir `external_message_id -> review_id` usando ou não estruturas atuais do Outbox;
- risk tier/policies finais das novas AdminOperations;
- UX/texto final das mensagens de Recepção.

Esses pontos não alteram as decisões de domínio desta spec.
