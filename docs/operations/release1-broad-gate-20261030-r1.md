# Release 1 — Gate de integração abrangente (30/10/2026)

- Base exata de código funcional: `8f3a0bbb17a8b7785377fe43d3fb3416370352d9` (bot Draft PR #283 sobre #282/#281).
- Esta branch de CI acrescenta apenas este marcador de evidência; não altera código, banco, runtime, flags nem distribuição.
- Objetivo: executar os workflows de push `gate/**` que não disparam automaticamente em PRs Draft empilhados; identificar regressões além das suítes focadas.
- Hub Draft PR #129 (SHA `269684878ab246309492f5e5c7872e81eb3c4b7a`) já teve crossrepo PG18 e Chrome sintético SUCCESS com a mesma árvore de código.
- Travamentos de publicação: staging real autenticado Premium, escolha IANA de reset Pesca, UAT aparelho WhatsApp e Ler mais, Gestão Pokémon, catálogo canônico PUBLISHED, inventário Windows do processo realmente ativo, backup/restauração DB+Baileys+ignorados e rollback validado, autorização explícita do proprietário.
- CI verde é **insuficiente** para GO: nada neste gate deve mesclar, publicar, reiniciar PM2, parear Baileys, migrar banco real ou anunciar jogadores.
- Checklist de autoridade: https://github.com/Otiosun/sla/issues/264 . Docs originais do Google Drive não foram sobrescritos (escrita 403).
