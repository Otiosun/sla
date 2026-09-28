# RPG Pokémon — Recepção Conversacional Persistente v2 — Design

Data: 2026-09-06
Status: DESIGN APROVADO EM CHAT, AGUARDANDO REVISÃO DA SPEC
Repo: `Otiosun/sla`
Base canônica: `main@48384689c291ef6d3be1c041b52f492060def652`
Branch da spec: `design/reception-conversation-v2`

Esta spec complementa e altera especificamente as decisões de UX conversacional e persistência transitória definidas em `docs/superpowers/specs/2026-09-01-reception-registration-design.md`.

Quando houver conflito entre as duas specs, esta v2 prevalece nos seguintes pontos:

- persistência automática de progresso durante o preenchimento;
- fluxo principal sem dependência de `$salvar`, `$ficha` ou `$confirmar`;
- estado conversacional persistido;
- um único prompt ativo por jogador;
- respostas livres aceitas somente como reply ao prompt ativo exato;
- respostas do bot visualmente ancoradas à mensagem do jogador;
- revisão automática e unificada após modo guiado ou ficha completa;
- correção por campo;
- erros de preenchimento contextuais e recuperáveis;
- parser de ficha completa multilinha.

As decisões anteriores sobre Registration, revisão administrativa, Player Onboarding, Player Access, Zhoulia, starter como intenção pré-aprovação e provisionamento pós-aprovação permanecem válidas.

---

## 1. Objetivo

Transformar a Recepção em uma conversa guiada, persistente e autoexplicativa, adequada a um grupo real de WhatsApp com várias pessoas falando ao mesmo tempo.

O jogador deve precisar conhecer apenas um comando para começar ou retomar:

`$registrar`

Depois disso, o caminho normal deve ser conduzido por replies a mensagens do bot e escolhas simples. Comandos antigos continuam existindo apenas como atalhos de recuperação, compatibilidade e uso avançado.

O fluxo deve maximizar simultaneamente:

- clareza;
- baixa fricção;
- segurança contra ativações acidentais;
- tolerância a reinícios;
- idempotência;
- capacidade de auditoria;
- isolamento entre jogadores no mesmo grupo;
- recuperação de erro sem becos sem saída.

---

## 2. Princípios canônicos de interação

### 2.1 Intenção explícita

Texto livre só é consumido quando houver um prompt ativo daquele jogador e a mensagem recebida for reply ao prompt ativo exato.

Portanto:

- texto solto no grupo: silêncio;
- número solto no grupo: silêncio;
- reply a outro jogador: silêncio;
- reply a prompt antigo do bot: silêncio;
- comando inexistente: silêncio;
- reply ao prompt ativo: processar;
- comando real registrado: processar conforme policy/estado.

Uma resposta semanticamente inválida ao prompt ativo não deve ser silenciosa. Nesse caso existe intenção inequívoca, então o bot explica o erro e mantém a etapa.

### 2.2 Um único prompt ativo por jogador

Cada jogador pode ter no máximo um prompt conversacional ativo.

Quando um novo prompt é emitido:

- o anterior deixa de ser aceito;
- o novo prompt passa a ser a única origem válida para freeform;
- o vínculo permanece válido sem timeout arbitrário;
- reinício do processo não deve apagar esse vínculo.

### 2.3 Bot responde ao jogador, não apenas ao grupo

Toda resposta conversacional do bot deve, sempre que tecnicamente possível, ser enviada como reply à mensagem do jogador que causou a transição.

Isso vale para:

- `$registrar`;
- escolha de modo;
- respostas guiadas;
- envio da ficha completa;
- escolhas de revisão;
- correções;
- erros contextuais;
- retomada;
- submissão.

O objetivo é formar uma linha visual reconhecível para cada jogador mesmo dentro de um grupo movimentado.

### 2.4 Confirmação de entendimento

O bot deve sempre sinalizar que entendeu uma resposta válida antes de avançar.

Campos curtos repetem o valor:

- `✅ 1/7 — Nome: Killian`
- `✅ 2/7 — Idade: 19`
- `✅ 7/7 — Pokémon inicial: Charmander`

Campos longos não ecoam todo o conteúdo:

- `✅ Aparência recebida.`
- `✅ Personalidade recebida.`
- `✅ História recebida.`

### 2.5 Progresso explícito

No modo guiado, perguntas devem indicar progresso, por exemplo `1/7`, `2/7`, ..., `7/7`.

O usuário nunca deve precisar descobrir quantas etapas faltam.

---

## 3. Persistência e semântica do rascunho

### 3.1 Autosave invisível

Cada resposta válida atualiza o checkpoint persistido automaticamente.

O jogador não precisa executar `$salvar` para proteger progresso.

Importante: autosave de rascunho NÃO equivale a submissão administrativa e NÃO concede nenhum efeito mecânico.

Continuam existindo três conceitos separados:

1. **checkpoint conversacional** — estado do fluxo e prompt ativo;
2. **registration draft** — dados editáveis atualmente preenchidos;
3. **registration revision** — snapshot imutável submetido à administração.

Somente o terceiro representa uma ficha oficialmente enviada para análise.

### 3.2 Tolerância a reinício

Após restart do Node, o sistema deve conseguir reconstruir:

- modo em uso;
- etapa atual;
- dados preenchidos;
- estado de revisão;
- prompt esperado ou necessidade de regenerá-lo.

Nenhuma informação importante para continuar o cadastro pode depender exclusivamente de `Map` em memória.

### 3.3 `$salvar`

`$salvar` deixa de ser parte necessária do fluxo principal.

Por compatibilidade, pode continuar registrado como alias de "pausar/confirmar que o progresso está salvo", sem alterar a semântica do draft.

A resposta deve informar que o progresso já estava salvo automaticamente.

---

## 4. State machine conversacional

Estados propostos:

```text
IDLE
  |
  | $registrar
  v
MODE_SELECT
  | 1                         | 2
  v                           v
GUIDED_FIELD                FULL_FORM
  |                           |
  +------------+--------------+
               v
             REVIEW
        +------+------+
        |             |
        | 1           | 2
        v             v
     SUBMITTED     EDIT_SELECT
                      |
                      v
                   EDIT_FIELD
                      |
                      +------> REVIEW

REVIEW -- 3 --> PAUSED
PAUSED -- $registrar --> RESUME_MENU

RESUME_MENU
  1 -> estado de continuação derivado do draft
  2 -> VIEW_CURRENT -> RESUME_MENU
  3 -> RESTART_CONFIRM

RESTART_CONFIRM
  1 -> novo MODE_SELECT
  2 -> RESUME_MENU
```

`VIEW_CURRENT` é somente uma visualização do que já foi preenchido. Ele não transforma draft incompleto em `REVIEW`.

`SUBMITTED`, `CHANGES_REQUESTED`, `APPROVED`, `REJECTED` e `WITHDRAWN` continuam pertencendo ao domínio de revisão. O `$registrar` deve interpretar esses estados e apresentar a próxima ação válida sem abrir cadastro duplicado.

---

## 5. Comportamento de `$registrar`

`$registrar` vira a home contextual da Recepção.

### Sem progresso

Inicia `MODE_SELECT`.

### Progresso incompleto

Exibe:

```text
🎒 Você já tem uma ficha em andamento.

1 — Continuar de onde parei
2 — Ver ficha atual
3 — Recomeçar
```

### Ficha pronta, ainda não submetida

Vai diretamente para `REVIEW`.

### Ficha submetida

Informa que a ficha está em análise e não inicia uma segunda ficha.

### Mudanças solicitadas

Abre revisão/correção a partir do draft derivado da última revisão apropriada.

### Aprovado/ACTIVE

Informa que o cadastro já foi concluído. Não reinicia onboarding.

### Recomeçar

É destrutivo e exige uma segunda escolha explícita:

```text
⚠️ Recomeçar apaga o rascunho atual.

1 — Sim, recomeçar
2 — Cancelar
```

Nunca apagar progresso por uma única escolha acidental.

---

## 6. Modo guiado

### 6.1 Entrada

Ao selecionar `1`:

```text
✅ Modo guiado escolhido.
Vamos fazer em 7 etapas. Nada será enviado sem sua confirmação.

📝 1/7 — Nome do treinador
Qual será o nome do personagem?
```

Isso confirma explicitamente que a escolha foi reconhecida.

### 6.2 Ordem dos campos

1. nome;
2. idade;
3. gênero/pronomes;
4. aparência;
5. personalidade;
6. história/resumo;
7. Pokémon inicial.

Zhoulia é preenchida automaticamente e não vira pergunta.

### 6.3 Transição normal

Cada resposta válida executa logicamente:

```text
validar -> persistir draft/checkpoint -> invalidar prompt anterior -> emitir confirmação + próximo prompt
```

Exemplo:

```text
✅ 2/7 — Idade: 19

📝 3/7 — Gênero / pronomes
Como quer registrar esse campo?
```

### 6.4 Último campo

Depois do starter, não deve existir mensagem vaga como "use `$ficha`".

A conclusão do último campo vai automaticamente para `REVIEW`, já mostrando a ficha inteira.

---

## 7. Ficha completa

### 7.1 Entrada

Ao selecionar `2`, o bot confirma o modo e mostra:

- instrução clara;
- starters atualmente permitidos;
- template completo;
- regra de responder àquela mensagem.

### 7.2 Parser multilinha

O parser deve aceitar blocos com múltiplas linhas até encontrar o próximo cabeçalho reconhecido.

Exemplo válido:

```text
História:
Killian nasceu em...
Segunda linha da história.
Terceira linha da história.

Pokémon inicial:
Charmander
```

O parser não deve descartar silenciosamente linhas adicionais.

### 7.3 Cabeçalhos

Continuar tolerando variantes normalizadas já previstas, mas sem interpretação fuzzy excessiva.

Cabeçalhos desconhecidos não devem deslocar conteúdo para o campo errado.

### 7.4 Estabilidade das opções apresentadas

Quando um prompt oferece opções numeradas de starter, a interpretação do número deve usar o conjunto e a ordem exibidos naquele prompt, não uma lista recalculada posteriormente.

O contexto do prompt deve persistir os IDs/opções necessárias para manter essa semântica estável.

Depois de resolver a escolha exibida, o starter escolhido ainda deve ser revalidado contra a configuração canônica atual. Se deixou de ser permitido, o bot explica a mudança e emite um novo prompt de starter sem apagar os outros campos.

### 7.5 Resultado

Ficha completa válida converge diretamente para `REVIEW`, igual ao modo guiado.

Os dois modos diferem somente na coleta. Depois da coleta, existe um único fluxo.

---

## 8. Revisão automática

`REVIEW` deve mostrar o snapshot atual e uma única decisão clara:

```text
📋 FICHA PRONTA PARA REVISÃO

Nome: ...
Idade: ...
Gênero / pronomes: ...
Aparência: ...
Personalidade: ...
História / resumo: ...
Pokémon inicial: ...
Região: Zhoulia

1 — Enviar para análise
2 — Corrigir alguma informação
3 — Continuar depois
```

Não exigir `$ficha`, `$confirmar` ou `$confirmar sim` no caminho normal.

### 8.1 Enviar

`1` cria a revisão imutável e muda para `SUBMITTED`.

A submissão continua sendo explícita e nunca ocorre automaticamente ao completar os campos.

### 8.2 Corrigir

`2` entra em `EDIT_SELECT`:

```text
✏️ O que deseja corrigir?

1 — Nome
2 — Idade
3 — Gênero / pronomes
4 — Aparência
5 — Personalidade
6 — História / resumo
7 — Pokémon inicial
8 — Voltar
```

Ao escolher um campo, entra em `EDIT_FIELD`, pede somente aquele valor, persiste a correção e retorna automaticamente para `REVIEW`.

### 8.3 Continuar depois

`3` muda para `PAUSED`, sem perder nada:

```text
💾 Seu progresso está salvo.
Quando quiser continuar, use `$registrar`.
```

Não há operação de save nesse momento; o autosave já ocorreu antes.

---

## 9. Erros de preenchimento

### 9.1 Erro do jogador

Erros esperados de validação não devem usar o presenter técnico genérico.

Exemplos:

- idade inválida;
- campo vazio;
- opção de menu inexistente;
- starter não permitido;
- ficha completa incompleta;
- campo duplicado;
- valor incompatível com o campo atual.

Resposta esperada:

```text
⚠️ Essa idade não é válida.
Envie apenas um número inteiro maior que 0.

📝 2/7 — Idade
Qual é a idade do personagem?
```

O estado não avança.

A mensagem de erro passa a ser o novo prompt ativo para aquela mesma etapa, permitindo que o usuário responda naturalmente ao erro.

### 9.2 Erro técnico

Falha inesperada de sistema deve:

- não corromper nem avançar estado;
- preservar o draft já confirmado anteriormente;
- usar mensagem curta;
- incluir código de suporte;
- fornecer caminho claro de retry.

Quando for seguro repetir a mesma entrada, a mensagem técnica de retry pode se tornar o novo prompt ativo da mesma etapa. Caso contrário, `$registrar` deve reconstruir a próxima ação segura a partir do estado persistido.

O código de suporte deve ser reservado para erro técnico, não para erro normal de preenchimento.

---

## 10. Prompt persistido e correlação exata

### 10.1 Estado persistido

Introduzir persistência explícita da conversa, conceitualmente em uma tabela como `registration_conversations`.

Campos mínimos esperados:

- `player_id` PK/FK;
- `provider`;
- `chat_ref`;
- `state`;
- `editing_mode` nullable;
- `current_field` nullable;
- `active_prompt_outbox_idempotency_key` nullable;
- `active_prompt_kind` nullable;
- `active_prompt_context_json` nullable;
- `flow_version`;
- `revision` para CAS/concorrência;
- `created_at`;
- `updated_at`.

`active_prompt_context_json` deve conter apenas dados necessários para interpretar de forma estável o prompt que foi mostrado, por exemplo a ordem/IDs das opções de starter. Não deve virar um segundo draft ou um depósito genérico de estado.

A implementação pode ajustar nomes às convenções do projeto, mas os invariantes devem permanecer.

### 10.2 Relação com Outbox

O prompt ativo deve apontar para a mensagem durável de Outbox, não para um valor efêmero de memória.

A validação de reply continua baseada em correlação entre:

- jogador;
- provider;
- chat;
- prompt ativo;
- Outbox realmente enviada;
- external message ID do provider.

O comportamento atual introduzido pela PR #155 é a base e deve ser preservado/endurecido, não removido.

### 10.3 Recovery de prompt ausente

Se o estado persistido referenciar um prompt que não existe, não foi enviado ou ficou inconsistente após crash, `$registrar` deve detectar essa condição e regenerar o prompt atual de forma idempotente.

Nunca deixar o jogador preso porque um ID de prompt ficou órfão.

### 10.4 Consistência de transição

Uma resposta válida não pode atualizar somente metade do estado lógico.

No mínimo, draft e conversation state/revision devem ser persistidos na mesma transação PostgreSQL ou por operação de repository equivalente com CAS.

Se a criação/entrega do Outbox falhar depois da transição de domínio, o estado deve permanecer recuperável pelo mecanismo da seção 10.3. O sistema não pode avançar o draft se a própria persistência do draft falhou.

A submissão continua usando a operação atômica de save + immutable review já existente no domínio Registration.

---

## 11. Outbound reply/quote

O contrato de mensagem de saída deve ganhar uma forma explícita e provider-neutral de solicitar resposta/quote à mensagem inbound que originou a transição.

Conceitualmente:

```ts
replyToExternalMessageId?: string
```

O adapter Baileys é responsável por transformar isso no formato correto do provider.

Se o provider exigir mais contexto do que apenas o ID externo, o adapter pode reconstruir esse contexto a partir do envelope inbound persistido ou de uma estrutura provider-specific interna ao adapter. Esse detalhe não deve vazar para Registration.

Invariantes:

- quando houver dados suficientes, o quote deve apontar para a mensagem exata do jogador;
- falha em montar quote não pode corromper a transição nem o Outbox;
- fallback para texto sem quote é aceitável apenas como degradação operacional, deve ser observável e não pode ser o comportamento normal da Recepção;
- não usar menção como substituto obrigatório do quote;
- o comportamento deve ter testes de adapter e de composição.

A implementação não deve introduzir payload provider-specific dentro do domínio Registration.

---

## 12. Concorrência e isolamento

### 12.1 Vários jogadores no mesmo grupo

Cada jogador possui seu próprio estado conversacional e prompt ativo.

A resposta de A nunca pode avançar o fluxo de B.

### 12.2 Mensagens concorrentes do mesmo jogador

Transições usam revision/CAS ou mecanismo equivalente.

Se duas respostas ao mesmo prompt chegarem quase simultaneamente:

- somente uma pode vencer;
- a outra deve ser tratada como stale/replay sem duplicar avanço;
- nunca pular dois campos.

### 12.3 Idempotência

Reentrega do mesmo inbound message ID não pode:

- duplicar autosave;
- gerar duas revisões;
- criar dois prompts sucessivos;
- avançar a state machine duas vezes.

---

## 13. Compatibilidade de comandos

O fluxo normal é conversacional, mas comandos existentes permanecem registrados quando fizer sentido:

- `$registrar` — home/contextual entrypoint;
- `$ficha` — mostra o draft/review atual sem ser obrigatório;
- `$salvar` — alias de pausa/compatibilidade; informa autosave;
- `$continuar` — alias para retomada contextual;
- `$modo` — atalho avançado para troca de modo quando o estado permitir;
- `$editar` — permanece para fluxo pós-submissão/revisão;
- `$confirmar` — compatibilidade; renderiza/retorna à revisão atual;
- `$confirmar sim` — compatibilidade; só pode submeter se o estado atual for `REVIEW` e o draft persistido ainda corresponder ao snapshot revisado.

Comandos desconhecidos continuam silenciosos.

Comando conhecido em estado inválido pode responder com mensagem contextual, porque existe intenção explícita e reconhecida.

Nenhum comando de compatibilidade pode criar uma segunda state machine paralela.

---

## 14. Revisão administrativa e submissão

A submissão continua criando uma `registration_revision` imutável.

A confirmação para o jogador e o anchor de revisão administrativa devem evitar duplicidade desnecessária de mensagens.

Preferência de UX:

- uma mensagem de sucesso pode servir também como anchor da review, desde que preserve o metadata necessário para `$verficha`, `$aprovar`, `$ajustes` e `$rejeitar`;
- essa mensagem deve responder à escolha de envio feita pelo jogador;
- a autoridade administrativa continua sendo validada por Admin Registry/policies, não pelo fato de responder à mensagem.

Nada nesta spec altera a regra de que aprovação administrativa ainda precisa provisionar perfil mecânico, Zhoulia, starter real, onboarding COMPLETE, localização inicial e PlayerAccess ACTIVE antes da liberação final.

---

## 15. Mudanças solicitadas pelo ADM

Quando a revisão estiver em `CHANGES_REQUESTED`:

- o draft deve ser restaurado/derivado do snapshot correto sem perder campos;
- `$registrar` deve reconhecer imediatamente que existem alterações solicitadas;
- se houver comentário administrativo estruturado disponível, mostrá-lo ao jogador;
- o fluxo deve levar para `REVIEW` ou `EDIT_SELECT`, não reiniciar a ficha inteira;
- uma nova submissão cria nova revisão imutável.

---

## 16. Revalidação de conteúdo

Starter é intenção pré-aprovação e depende do catálogo ativo.

Ao retomar uma ficha antiga ou submeter:

- revalidar `starterFormId` contra a configuração canônica aplicável;
- se ainda for válido, preservar;
- se deixou de ser válido, não apagar silenciosamente o restante da ficha;
- marcar somente starter como necessitando nova escolha e conduzir o jogador até esse campo.

O mesmo princípio vale para qualquer futura dependência de catálogo.

---

## 17. Separação de componentes

A implementação deve evitar continuar concentrando responsabilidades em `conversation-resolver.ts` e `whatsapp-handlers.ts`.

Unidades propostas:

### `RegistrationConversationService`

Responsável por:

- carregar estado persistido;
- validar transição;
- autosave;
- CAS;
- pause/resume;
- review/edit state;
- recovery de prompt.

### `RegistrationConversationRenderer`

Responsável por gerar texto de:

- mode select;
- perguntas guiadas;
- confirmações;
- ficha completa;
- review;
- menus de correção;
- erros contextuais.

Não escreve DB e não decide autorização.

### `RegistrationReplyIntentVerifier`

Permanece responsável por provar que o reply aponta ao prompt ativo realmente enviado.

### `RegistrationConversationRepository`

Persistência isolada de state/CAS e operações transacionais necessárias para manter draft + conversation consistentes.

### `RegistrationFullFormParser`

Parser multilinha independente, com testes próprios.

### Messaging/WhatsApp adapter

Responsável somente por:

- normalização inbound;
- admission de comando/freeform;
- Outbox;
- quote/reply provider-specific;
- entrega.

Registration não deve depender de estruturas internas do Baileys.

---

## 18. Migração da implementação atual

A migração deve ser incremental e preservar o comportamento seguro da PR #155.

Ordem conceitual:

1. adicionar persistência conversacional;
2. mover prompt ativo de memória para persistência;
3. suportar outbound quote/reply;
4. extrair renderer;
5. implementar autosave;
6. transformar guided/full em coletores que convergem para REVIEW;
7. adicionar EDIT_SELECT/EDIT_FIELD/PAUSED/RESUME_MENU/RESTART_CONFIRM;
8. melhorar erros contextuais;
9. corrigir parser multilinha;
10. manter comandos como compatibilidade;
11. remover dependências antigas de `Map` somente depois dos testes de restart.

Não remover a proteção de prompt exato durante a transição.

---

## 19. Testes obrigatórios

### Unitários

- state transitions válidas e inválidas;
- renderer por estado;
- parser multilinha;
- validação contextual por campo;
- menu de correção;
- restart confirmation;
- estabilidade de opções numeradas por prompt;
- revalidação de starter.

### Messaging

- texto solto ignorado;
- número solto ignorado;
- reply humano ignorado;
- reply a prompt antigo ignorado;
- reply ao prompt ativo aceito;
- resposta inválida ao prompt ativo gera correção e novo prompt;
- comando inexistente ignorado;
- comando conhecido em estado válido funciona;
- confirmação visual da resposta + próxima pergunta;
- guided termina automaticamente em REVIEW;
- full termina automaticamente em REVIEW;
- correção de um campo retorna a REVIEW;
- visualização de draft incompleto não o transforma em REVIEW.

### PostgreSQL integration

- autosave sobrevive a restart;
- prompt ativo sobrevive a restart;
- CAS impede avanço duplo;
- reentrega inbound é idempotente;
- draft e conversation permanecem consistentes;
- submit cria exatamente uma revisão;
- pause/resume não perde dados;
- restart confirmado cria novo draft/conversation corretamente;
- prompt órfão é recuperável por `$registrar`.

### Adapter Baileys

- outbound reply referencia mensagem correta;
- degradação sem quote é observável;
- provider external message ID continua determinístico para correlação de prompt.

### E2E Reception

Cenário mínimo realista:

1. `$registrar`;
2. escolha guiada por reply;
3. preenchimento 1/7 a 7/7;
4. chatter paralelo no grupo ignorado;
5. reply antigo ignorado;
6. erro de idade corrigido sem perder etapa;
7. restart no meio da ficha;
8. `$registrar` retoma do ponto correto;
9. conclusão automática em REVIEW;
10. editar história;
11. voltar à REVIEW;
12. pausar;
13. retomar;
14. enviar;
15. revisão administrativa continua funcional.

Outro E2E equivalente deve cobrir FULL com conteúdo multilinha e alteração de catálogo entre emissão do prompt de starter e resposta.

---

## 20. Critérios de aceitação

A v2 só pode ser considerada concluída quando todos os itens abaixo forem verdadeiros:

- jogador consegue completar o cadastro sem usar nenhum comando depois de `$registrar`;
- todo passo relevante informa claramente o que foi entendido e o que vem a seguir;
- guided e full convergem automaticamente para a mesma revisão;
- correção de campo é conversacional;
- progresso é autosalvo;
- restart não perde etapa nem draft;
- replies antigos não funcionam;
- chatter do grupo não ativa o bot;
- comandos inexistentes não ativam o bot;
- erros de usuário são específicos e não exibem código técnico;
- erros técnicos preservam estado e possuem código de suporte;
- ficha completa aceita blocos multilinha corretamente;
- opções numeradas continuam significando o que foi mostrado naquele prompt;
- bot responde visualmente à mensagem do jogador quando suportado;
- concorrência não permite avanço duplicado;
- submissão continua explícita e cria revisão imutável;
- nenhuma concessão mecânica acontece antes da aprovação/provisionamento;
- testes unitários, integração PostgreSQL, WhatsApp Proof e Reception E2E passam.

---

## 21. Fora de escopo desta v2

- Central ADM visual;
- múltiplos personagens por identidade;
- múltiplas regiões iniciais;
- IA para interpretar ficha livre sem estrutura;
- workflow engine genérico para todo o RPG;
- redesign completo da revisão administrativa;
- mudança das regras de provisionamento pós-aprovação;
- conteúdo textual final de branding/copy além do necessário para UX funcional.

A arquitetura deve permitir evolução futura, mas não deve transformar a Recepção v2 em um workflow engine universal antes de existir necessidade real.

---

## 22. Decisão final

A Recepção v2 será implementada como uma **state machine conversacional persistente especializada em Registration**, integrada à infraestrutura existente de Inbox/Outbox, Registration, Community, Admin e PostgreSQL.

O sistema continuará fail-closed para mensagens sem intenção inequívoca, mas passará a ser proativo e autoexplicativo depois que o jogador entrar deliberadamente no fluxo.

A regra de produto pode ser resumida assim:

> O jogador começa com `$registrar`. Depois disso, o bot conduz, confirma, salva e recupera todo o processo. Nada é submetido sem confirmação explícita, e nada fora do prompt ativo interfere na ficha.
