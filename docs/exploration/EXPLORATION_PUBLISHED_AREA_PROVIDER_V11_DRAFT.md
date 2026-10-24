# Exploração V1.1 — provider de cobertura publicada (DRAFT)

## O que foi alterado

- Um `PostgresPublishedExplorationAreas` lê a ACTIVE release somente se
  `content_releases.status=PUBLISHED` e o ruleset correspondente estiver
  `PUBLISHED`. O ID esperado do World deve coincidir exatamente.
- Seleciona áreas de Zhoulia no recorte Vila dos Arrozais/Campos de Yun,
  exigindo revisões ativas de região e área, tabela de encontro ativa e
  pelo menos uma entrada ativa com forma/espécie ativas **na mesma release**.
- A leitura usa transação PostgreSQL `REPEATABLE READ READ ONLY`.
- `ExpeditionWorldPreview` encadeia `WorldService.getLocation`,
  provider publicado e `inspectExplorationWorld` da PR #247.
- Nenhuma mutation de banco, chamada WhatsApp ou implantação é executada.

## Por quê

O catálogo autorado de Zhoulia não é uma garantia de publicação. Sem esses
filtros, uma área draft/sem encounters poderia ser apresentada ao jogador como
disponível. Os destinos dependem das conexões oficiais do World.

## Limites conscientes

A existência de cobertura **não** prova elegibilidade do encontro em determinado
horário, superfície, clima ou desbloqueios de tabela/espécie. Esses filtros
permanecem para o futuro EncounterService e para a primeira ação transacional.
O resultado também pode ficar obsoleto caso a release do mundo mude entre
o preview e o início da ação; por isso o preview NUNCA autoriza débito de cota.
Não há custo inventado de viagem (o `travelSeconds` canônico é cooldown em
tempo real, não minutos internos da expedição).

O próximo passo é uma transação compartilhada para localização/World,
permissões, relógio de expedição, efeitos reais e recibo idempotente, com
testes de mudanças concorrentes. Depois migração numerada (sem colisão
com 0076–0078), UX Rotom e QA. Nada foi aplicado no PM2/DB/WhatsApp real.
