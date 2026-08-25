# Contributing

## Regra principal

`main` é a linha canônica. Depois do bootstrap de repositório vazio, mudanças normais entram por pull request com CI verde e revisão do diff.

## Branches

Use um escopo coerente por branch:

- `feat/`
- `fix/`
- `refactor/`
- `infra/`
- `migration/`
- `docs/`
- `hardening/`

Não misture feature funcional com refactor amplo sem necessidade demonstrável.

## Commits

Mensagens devem explicar o que mudou. Evite `misc`, `stuff`, `final`, `fix 7` e equivalentes.

## Pull request

Todo PR deve registrar:

1. objetivo e escopo;
2. riscos e invariantes afetados;
3. migration/schema, se houver;
4. testes executados e evidências;
5. impacto de rollback/compensação;
6. impacto documental no Drive;
7. DEC/ARQ relacionada quando arquitetura ou regra mudar.

## Antes do merge

```bash
pnpm install --frozen-lockfile
pnpm check
```

Migrations já aplicadas são imutáveis. Correções recebem nova migration.

Secrets nunca entram em Git, issue, PR, log ou Drive em texto puro.
