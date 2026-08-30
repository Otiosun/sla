# Admin Control Plane — Boundary de API v0.1

Status: arquitetura executável em construção.
Escopo desta etapa: leitura administrativa segura para Player 360. Nenhuma mutation HTTP é autorizada por este documento.

## 1. Objetivo

Expor o Admin Operation Registry e suas projeções ao Pokémon Control Center sem transformar o frontend, o transporte HTTP ou um BFF em nova autoridade mecânica.

A cadeia de autoridade permanece:

`Control Center -> sessão autenticada -> Admin API adapter -> AdminService / Player360Service -> owner/repository -> PostgreSQL`

O adapter HTTP não escreve tabelas mecânicas e não reimplementa capability, scope, risk, revision, idempotency ou invariantes.

## 2. Invariantes de identidade

1. `principalId` nunca vem de body, query string, header arbitrário ou localStorage controlado pelo browser.
2. O servidor resolve `principalId` a partir de uma sessão administrativa autenticada e validada.
3. Capability e scope nunca são aceitos do cliente como autoridade. O cliente pode receber uma projeção segura para UX, mas a autorização é recalculada server-side a cada request.
4. `OWNER_SECURITY_ADMIN`/MASTER não bypassa o Registry. Ele possui o catálogo registrado de capabilities; não possui SQL arbitrário.
5. Sessão desabilitada/revogada falha fechada.
6. Ambiente efetivo é definido pelo servidor/deploy. O cliente não escolhe PROD/STAGING por um parâmetro livre.

## 3. Primeiras operações expostas

Somente READ:

- `player.search` -> `Player360Service.search`
- `player.search_sensitive` -> autorização adicional quando `includeSensitive=true`
- `player.read` -> `Player360Service.get`
- `player.read_sensitive` -> autorização adicional quando `includeSensitive=true`

Nenhuma capability nova de busca será inventada. O Registry canônico já associa `player.search` a `player.read` e `player.search_sensitive` a `player.read_sensitive`.

## 4. Contrato de transporte pretendido

Rotas futuras, após autenticação/sessão estarem implementadas:

- `GET /admin/v1/session`
- `GET /admin/v1/players`
- `GET /admin/v1/players/:playerId`

O transporte converte query/path para o contrato de aplicação e injeta o principal da sessão. O facade de aplicação nunca recebe `principalId` dentro do input controlado pelo cliente.

## 5. Resposta de sessão

`/admin/v1/session` poderá devolver somente uma projeção segura necessária à UX:

- nome/label do operador;
- principal id quando operacionalmente necessário;
- roles efetivos;
- capabilities efetivas para disclosure da interface;
- scopes efetivos;
- ambiente;
- expiração da sessão.

Isso não substitui autorização server-side.

## 6. Dados sensíveis

- busca por identidade externa exige `includeSensitive=true` e autorização `player.read_sensitive`;
- credenciais, tokens, segredos, material de pairing do WhatsApp e backups nunca entram em payloads do Control Center;
- logs HTTP devem evitar query/body sensíveis por padrão;
- erros de autorização não devem vazar detalhes de policy interna desnecessários.

## 7. Erros de transporte

Mapeamento inicial recomendado:

- não autenticado -> 401;
- `ADMIN_AUTHORIZATION_DENIED`, principal desabilitado/inválido -> 403 (sem detalhes internos sensíveis);
- `ADMIN_INVALID_INPUT` -> 400;
- `ADMIN_TARGET_NOT_FOUND` -> 404;
- conflitos de revisão/idempotência futuros -> 409;
- demais falhas inesperadas -> 500 com correlation id, sem stack para o cliente.

O código canônico `AdminError.code` continua sendo a origem da classificação; HTTP apenas o traduz.

## 8. Mutations bloqueadas nesta fase

Nenhuma rota de alteração será ligada antes de existir prova de:

- autenticação e revogação de sessão;
- proteção de origem/CSRF quando aplicável ao modelo de sessão;
- contexto de ambiente explícito;
- correlation/request id;
- auditoria contextual;
- política de rate limiting/abuse para o plano administrativo;
- contrato de confirmação/approval para operações de risco.

## 9. Framework HTTP

Não escolhido nesta etapa. A primeira implementação é transport-neutral para evitar acoplar segurança e domínio a um framework antes da decisão técnica. O framework deverá apenas adaptar request/response, lifecycle e middleware para esta boundary.

## 10. Regra de conclusão

A API read-only só é considerada utilizável pelo Control Center quando houver teste provando que um `principalId` enviado pelo cliente não consegue substituir o principal da sessão e que leituras sensíveis continuam exigindo autorização server-side.
