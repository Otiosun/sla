# RPG Pokémon

Repositório canônico de implementação de um RPG Pokémon para WhatsApp.

Este projeto nasce **do zero**.

## Stack base

Node.js 24.19.0 LTS · TypeScript 7.0.2 strict · pnpm 11.23.0 · Biome 2.5.10 · Vitest 4.1.11 · Zod 4.4.3 · node-postgres 8.23.0 · PostgreSQL 18.6.

## Fontes de verdade

- **GitHub:** código, migrations, testes, seeds/importers, CI/CD e releases.
- **Google Drive:** arquitetura, decisões, auditorias, checklist, checkpoints, QA e handoffs.

O nome atual do repositório é provisório; a identidade canônica é repository ID `1342507339`.

## Bootstrap local

Ambiente local/teste usa uma única credencial PostgreSQL para reduzir atrito:

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:verify
pnpm check
pnpm dev
```

`DATABASE_URL` é a credencial de runtime. `MIGRATOR_DATABASE_URL` é separada e obrigatória em staging/produção, e deve usar outro login PostgreSQL. Nenhum secret deve entrar no Git ou Drive em texto puro.

## Banco e migrations

- `db/migrations/0001_core_schema.sql` é schema, não seed de conteúdo.
- `schema_migrations` é bootstrap do runner e registra version/name/checksum/applied_at/applied_by.
- migrations aplicadas são imutáveis; SHA-256 divergente é erro fatal.
- o runner usa advisory lock para impedir dois migrators simultâneos.
- runtime verifica o schema e falha se o banco estiver atrasado.
- roles e grants operacionais ficam em `db/bootstrap/`, separados das migrations numeradas.

Staging/produção seguem obrigatoriamente a ordem fail-closed documentada em `db/bootstrap/README.md`: **roles → migrate → runtime grants → verify → start runtime**. Uma tabela recém-criada não fica acessível à aplicação até a reconciliação explícita de privilégios.

```bash
pnpm db:migrate
pnpm db:verify
pnpm test:db
```

## Qualidade

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm check
```

## Arquitetura

```text
src/modules/{player,catalog,pokemon,inventory,economy,world,encounter,battle,capture,progression,pokedex,admin,narrative-ai}
src/platform/{db,logging,config,clock,rng}
src/adapters/whatsapp
db/{migrations,bootstrap,seeds,imports}
tests/{config,db}
```

Monólito modular: regra de negócio não mora em adapter de WhatsApp, SQL solto ou camada narrativa. APIs externas nunca são chamadas com uma transação de gameplay aberta.

## Fluxo Git

Desenvolvimento normal usa branch → PR → CI → revisão → merge. Consulte `CONTRIBUTING.md`.
