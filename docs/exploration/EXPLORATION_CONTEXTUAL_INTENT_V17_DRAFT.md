# Exploração V1.7 — interpretação contextual WhatsApp (Draft)

**Estado:** `expedition-contextual-menu.ts` contém somente parser e renderer puro. Não foi conectado a `/explorar` e não executa nenhuma ação.

## Contrato

- Cada resposta curta é interpretada **exclusivamente** contra o menu de opções que o servidor acabou de disponibilizar naquele contexto.
- Números `1`–`20` podem selecionar uma ação previamente oferecida. Números em notação exponencial, hexadecimal, com sufixos, encadeados ou fora do menu são inválidos.
- Frases simples e sotaques/acentos em PT-BR são normalizados (NFKC/NFD), mas cada expressão precisa estar **explicitamente configurada** como alias único da opção.
- `sim`, `não quero ele`, `pokebola` e semelhantes **não** são autorização global para captura, gasto de item ou tempo. Só podem ser resolvidos quando não houver ambiguidade e a opção estava visível no menu correto.
- Espécie digitada com erro, como `shromish`, não dispara caça nem resultado. Futura desambiguação segura deverá vir da Pokédex já conhecida e de tabela elegível.
- Um menu de múltiplas ações que aceitam `sim` recusa a resposta e orienta a usar número.
- Inputs longos/multilinha, comandos mecânicos encadeados, aliases com markup/controle e menu duplicado falham sem efeitos.
- O retorno distingue consulta gratuita de proposta de ação mecânica que **ainda exige** autorização ativa, preparo mecânico, guardas de sessão/World, relógio, reservas e transação.
- Renderer sanitariza rótulos para impedir que nomes injetem comandos, URLs enganosas ou formatação nativa. Segue a identidade `ROTOM · EXPLORAÇÃO`; não substitui o asset protegido do Rotom.

## Integração exigida

Persistir revisão do menu contextual por jogador/expedição e correlacionar resposta ao prompt de origem. Impedir que números antigos selecionem uma opção nova após viagem, batalha, reset ou replay. Mensagens de terceiros e grupos não podem alterar a expedição de um jogador. Opções de captura devem ser resolvidas por inventário real e pela janela do turno, sem usar nomes livres ambíguos.

Mesmo depois do parser, não habilitar comando jogável antes de completar V1.1–V1.6, UAT WhatsApp por papéis/estados, migração autorizada e prova de restauração do backup.
