# RPG Pokémon — Engine Narrativa e Mecânica

Repositório canônico de implementação do novo RPG Pokémon para WhatsApp.

Este projeto nasce **do zero**. Clover e Pokestor são referências de auditoria; nenhuma dívida legada é copiada automaticamente.

## Stack base

- Node.js 24.19.0 LTS
- TypeScript 7.0.2 (`strict`)
- pnpm 11.23.0
- Biome 2.5.10
- Vitest 4.1.11
- Zod 4.4.3
- PostgreSQL 18.6 para CI/integração

As versões são exatas e só mudam por alteração deliberada e testada.

## Fontes de verdade

- **GitHub:** código, migrations, testes, seeds/importers, CI/CD e releases.
- **Google Drive canônico:** arquitetura, decisões, auditorias, checklist, checkpoints, QA e handoffs.

O nome atual do repositório (`sla`) é provisório. A identidade canônica é o repository ID `1342507339`; um rename futuro não altera histórico ou identidade.

## Bootstrap local

Pré-requisitos: Node 24.19.0 e pnpm 11.23.0.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`DATABASE_URL` é obrigatória. O loader falha imediatamente se a configuração mínima for inválida.

## Comandos

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm check
pnpm dev
```

## Arquitetura inicial

```text
src/
  modules/
    player catalog pokemon inventory economy world encounter battle
    capture progression pokedex admin narrative-ai
  platform/
    db logging config clock rng
  adapters/
    whatsapp
db/
  migrations/
  seeds/
  imports/
tests/
```

A estrutura é um monólito modular. Regra de negócio não deve morar em adapter de WhatsApp, SQL solto ou camada narrativa.

## Fluxo Git

Após o commit excepcional que inicializou o repositório vazio, desenvolvimento normal usa branch → PR → CI → revisão → merge. Consulte `CONTRIBUTING.md`.
