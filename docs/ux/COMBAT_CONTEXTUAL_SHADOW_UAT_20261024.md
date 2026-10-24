# Staging invisível ao jogador · UX contextual de combate

Base: PR #245 (Premium), com Head inicialmente `8ca711cd87f21ada605e7dcf7651990ef20748e4`. Este incremento é **independente** da stack Draft de exploração #247–#254 e não a mescla.

## O que já existe e foi reutilizado
- `createOperationalSimulatedWhatsAppRuntime` e `SimulatedWhatsAppAdapter` são uma alternativa de teste sem Baileys e sem segundo número de WhatsApp; `tests/uat/headless-narrator-pve.integration.test.ts` já verifica ingresso normalizado, Inbox/Outbox, captura, replay e recriação de composição em PostgreSQL descartável.
- O WhatsApp ativo no Windows/PM2 não é alterado, e nenhum novo processo precisa ser mantido.
- As mensagens são as strings finais dos renderizadores reais do Bell; não são uma imagem conceitual.

## Primeira melhoria concreta
O HUD canônico `/batalha` mantém turno, nomes, HP e visual Bell. A nova seção `◇ *𝗣𝗥Ó𝗫𝗜𝗠𝗔 𝗔ÇÃ𝗢*` mostra `/moves` para inspeção, `/movimento <número>` se há PP/movimento elegível, `/trocar <número>` somente com reservas controladas e vivas usando os slots atuais e `/fugir` somente no encontro WILD. O sistema não anuncia `/capturar` indiscriminadamente sem conferir inventário e elegibilidade.

Turno já enviado: não repete comandos como se a pessoa ainda pudesse agir. Troca obrigatória após KO continua sendo tratada pelo ramo original com reserva obrigatória. Controle narrativo e automático não devem receber ações de treinador. `/combate` apresenta os verbos mecânicos com ressalva de troca condicionada.

## Critérios de prova e fronteiras
- Testes de mensagens: PvE normal, PvP sem fuga, golpes sem PP, com/sem reservas, posição da reserva, turno enviado, narrador e permissões.
- Fluxo com banco descartável: narrador `/spawn` → `/iniciarbatalha` → treinador `/batalha` → captura → replay/restart/fuga, validando texto e Outbox verdadeiros.
- Rodar lint, format, typecheck, testes e CI remota em uma branch de gate **com o SHA exato**; resultados devem ser anexados à PR após execução, sem alegar aprovação prematura.
- Ainda pendentes: revisão do PvP em todos os estados, reações e erros recuperáveis, sessões reais, demais sistemas de A–H, integração do código privado do Windows, validação do catálogo ACTIVE, restauração real de PostgreSQL e anúncio/deploy.

## Modelo de publicação
Produção permanece no seu PM2 atual. A versão invisível é a branch/PR candidata e seu banco **separado, descartável**, não um segundo cliente Baileys. Só integrar em runtime ativo após fechamento de checklist, UAT de sessão real em local apropriado, backup restaurável e autorização editorial.
