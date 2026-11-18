# Exploração 2.0 — laboratório isolado D07

Status: NÃO instalado. Branch separada da main, sem deploy.

## Implementado no laboratório

- Núcleo puro do Caderno de Campo. Exige observações com jogador, release, expedição, área, período, evento, verificação e entrega confirmada. Não gera Pokémon, XP, itens ou chances de encontro.
- Dez testes de unidade de proveniência, economia pendente, espécie não revelada e replay; execute: node --test experiments/exploration-d07/caderno-campo-core.test.mjs
- Pacote separado de teste sintético captura e XP da D06 instalada, a executar somente no clone PostgreSQL em BEGIN/ROLLBACK.

## Pendências antes de integrar

1. Homologar D06 captura e XP no clone, depois CaptureService com Ball e PvE completo.
2. Ligar Caderno ao banco e Outbox. Não marcar verified ou delivered sem provas reais.
3. Publicar pontos apenas se mudarem resultados e forem catalogados.
4. Testar menus, 720 minutos, Cena ON, autorização, replay e impactos econômicos.
5. Validar o cliente WhatsApp quando estiver acessível.

D06 privada, main, bot público, portal e PostgreSQL de produção permanecem intocados.

Fonte: https://docs.google.com/document/d/1S2sHv76gbpHcj-6cbWYyd4cyVljehqn0JYRKJg0kRto/edit
Diário: https://docs.google.com/document/d/1j1Z4cEZ2uhBzZ2My8R6teV3UR4dJlDmyeycHGl50a0Q/edit
