# Exploração Individual V1.1 — duração canônica da viagem (DRAFT)

## Decisão técnica aplicada

O dossiê aprovado não fornece custo interno da conexão Vila dos Arrozais ↔
Campos de Yun; ele proíbe usar os 45 minutos do exemplo como se fossem
dados oficiais. `travelSeconds` no World é um cooldown de tempo REAL e
não um débito do relógio da expedição.

Para impedir que o adaptador de viagem da PR #250 cobre uma duração
arbitrária, este incremento adiciona o campo **opcional**
`explorationMinutes` a `ConnectionAccessRuleSchema`, validado como
inteiro de 1 a 720. Ele faz parte da revisão da CONEXÃO na release de
conteúdo publicada: pode ser preenchido somente mediante aprovação da
política de tempo da rota e publicação controlada dessa release.

O módulo `PostgresExpeditionFirstAction` envia os `minutes` cobrados
ao efeito via `FirstActionContext` dentro da mesma transação. A callback
`canonicalWorldTravelEffect` usa o WorldRepository para consultar
`connectionBetween(contentReleaseId, fromAreaId, destinationAreaId)`
no próprio `PoolClient`, confirma que a conexão está ativa e **exige
que os minutos cobrados coincidam exatamente** com
`accessRule.explorationMinutes`. Se ausente ou divergente, retorna erro;
o rollback desfaz cota, relógio, visitas e mudança de localização.

Não convertemos `travelSeconds`, não adotamos um valor padrão e não
modificamos nenhuma revisão de rota REAL.

## Status da rota inicial

Vila dos Arrozais ↔ Campos de Yun: **minutos ainda NÃO aprovados**.

Os testes PostgreSQL descartáveis usam `explorationMinutes: 30` na
conexão FICTÍCIA Vila → Yun unicamente para testar igualdade e rollback.
A conexão fictícia oposta Yun → Vila tem somente
`travelSeconds: 180`, e a ação de viagem deve ser recusada. Nenhum desses
valores é conteúdo publicado no RPG de produção.

## O que ainda falta

- Product owner/revisão de balanceamento aprovar o tempo interno por
  **direção/conexão**, sem confundi-lo com cooldown real ou exemplo;
- materializar esse valor na revisão de conexão publicada após controle
  de conteúdo e validação de acesso/roteamento;
- cobrir viagens quando a expedição já está ACTIVE, garantindo que o
  estado corrente e o histórico de origem sejam preservados corretamente;
- UAT de Rotom/WhatsApp; colisões de viagem/outros comandos; restore
  privado e migração numerada depois do bloco Premium.

Todas as mudanças estão em PR Draft isolada; nenhuma migração, deploy,
ativação do /explorar, banco real ou PM2 foi tocado.
