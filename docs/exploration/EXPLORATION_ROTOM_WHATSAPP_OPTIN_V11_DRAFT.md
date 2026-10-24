# Rotom WhatsApp · exploração individual V1.1 — opt-in de homologação

Base dependente: PR #253 (HEAD a2d0cba90e3df8d90ccd4ff296d4e37f7d9174c8), depois da stack #247–#252. Nenhum merge/deploy é autorizado por este documento.

## Contrato de uso

- `/explorar` abre o STATUS de leitura. `/explorar status` e `/explorar retomar` são sinônimos de CONSULTA e não iniciam ou retomam mecânica temporal.
- A rota passa pelo `RuntimeCommandPolicyGate`: exige acesso ACTIVE e preparo mecânico. A identidade é resolvida pelo player registration canônico; onboarding diferente de COMPLETE não consulta dados da expedição.
- O Rotom envia a resposta **ao remetente privado** (`senderRef`), mesmo quando o pedido veio de grupo; não publica a localização e cotas no chat da comunidade.
- O serviço existente `ExpeditionRotomPreviewService` valida World, release publicada e cursor; leitores PostgreSQL seguem somente leitura.
- Comandos como `/explorar viajar ...`, `/explorar capturar` e argumentos desconhecidos recebem instrução sem consultar dados ou executar qualquer ação.
- A mesma mensagem retransmitida produz a mesma chave Outbox por ID de mensagem do provedor. A infraestrutura existente de Inbox/Outbox é responsável pela entrega idempotente; o handler não armazena sessões próprias.

## Opt-in restrito

`createOperationalMessagingComposition(pool, rng, media, battle, hubUrl, { enabled: true, timeZone: "TZ_APROVADA" })` registra a rota somente quando o opt-in explícito é injetado. As composições real e simulada admitem a opção, mas por padrão não a fornecem. **Nenhum arquivo .env, flag operacional, PM2 ou deploy foi modificado para ativar essa opção.**

Não habilitar em instalações sem DDL `solo_expeditions` validado e sem catálogo de encontros ACTIVE comprovado. A zona horária deve ser a configuração do mundo oficialmente aprovada, não deduzida do Windows ou do servidor. Usar apenas PostgreSQL descartável/staging preparado.

## Pendências de produto e segurança

- A consulta é read-only; não há botão, opção numerada, comando de preparação persistente ou ação de caça.
- O período Diurno/Noturno é apresentado para expedições existentes; a origem histórica não é inventada como rótulo quando só existe o ID.
- Nenhuma duração Vila ↔ Campos de Yun foi aprovada. `travelSeconds` não equivale aos minutos de expedição.
- Não autoriza migração numerada, homologação de jogadores reais, restauração do backup Windows, cutover, restart PM2 ou ativação.
- Provas automatizadas aqui cobrem roteamento, autorização, privacidade da resposta, entradas inválidas, erros de World/catalogo e retransmissão. CI remota precisa ser registrada separadamente; gates de staging não equivalem a produção.
