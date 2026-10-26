# Pokémon Beyond — Jornada Narrada: direção simplificada (26/10/2026)

**DECISÃO EDITORIAL MAIS RECENTE, QUE SUBSTITUI A PROPOSTA ANTERIOR.**
Status: UX corrigida por feedback do usuário. O texto anterior que defendia sessões formais, novos comandos para gerenciar Jornada e registros de participação fica **revogado**. Nada foi implementado ou publicado.

## Regra-mãe
**Narrador conduz a ficção; jogadores Cenam; bot aparece apenas quando há mecânica real necessária.**
- Jornada Narrada é fundamentalmente RPG de interpretação humana, sem gerenciador de sessões automático.
- Descartar comandos propostos /jornada iniciar, /jornada pausar, /jornada retomar, /jornada encerrar e painéis de abertura/fechamento para toda Jornada; não criar check-ins, marcadores automáticos de capítulo nem missões automáticas pela prosa.
- Não exigir /cena para conversa e Cenas livres. Jogadores e narrador interagem normalmente, sem bot reagindo a cada fala. Reply não transforma comentário em comando.
- Regra de **50 palavras** permanece para Cenas **formais exigidas por mecânicas**: PvE/PvP e comprovantes de Cena de serviços específicos. Não exigir 50 palavras para cada diálogo ou mensagem casual na Jornada.
- Jornada Narrada não herda relógio e cotas da Exploração Individual. Narrador determina história, NPCs, pistas, ritmo e episódios. Texto não cria XP, loot, Pokémon, captura ou teleporte mecanicamente.
- Nunca criar estado mecânico por interpretação automática de texto livre ou inventar recompensa.

## Principal ferramenta: /spawn já existente
Preservar e lapidar o /spawn do narrador (código em src/modules/encounter/spawn-whatsapp.ts).
- A rota existente exige capacidade administrativa encounter.support em grupo PvE, menção real ao alvo, verificação de co-localização/party e bloqueios quando grupo dividido ou em deslocamento. O parser existente permite modificadores como espécie, nível, quantidade, shiny, ataque de abertura e automático, sob os limites reais do sistema.
- Comando simples do narrador: /spawn @treinador. Bot apresenta encontro canônico e oferece os comandos mecânicos adequados; não substituir por lobby ou interface de sessão.
- Limitação auditada: a criação atual envia participantPlayerIds: [] — colegas da party não entram automaticamente em um combate conjunto. Futuro aperfeiçoamento cooperativo é um trabalho da mecânica do encounter/battle, não um gerenciador de Jornada.
- Atenção: parseSpawnCommand exige /spawn no início da primeira linha mesmo com allowEmbedded, logo não prometer que /spawn em qualquer trecho narrativo já funciona. A decisão de comando em qualquer posição deve ser auditada por rota, não presumida universal.
- Melhorias pontuais úteis: aparência contextual do encontro, mensagens compactas e bem escritas, argumentos flexíveis sem ambiguidade, erros seguros, permissões e idempotência.

## Simulação realista mínima
1. Narrador posta cena da mata, NPCs e mistério. Bot silencioso.
2. Jogadores Cenam, interagem e investigam; conversa normal no grupo. Bot silencioso.
3. Narrador decide aparecer um selvagem: /spawn @treinador. Bot cria/mostra encontro permitido.
4. Jogador inicia batalha ou captura, com Cena formal >=50 palavras + ação mecânica, conforme regras já fixadas para PvE. Bot resolve e apresenta resultado verdadeiro.
5. Narrador interpreta consequências e continua a história. Bot silencioso.
6. Narrador conclui a Jornada com mensagem humana, sem novo comando de encerrar sessão.

## Ferramentas adicionais — somente se houver necessidade comprovada
- Comandos canônicos de combate, captura, fuga, consulta de estado, eventual limpeza administrativa de um encontro travado.
- Cooperação PvE de verdade quando houver autorização e modelo de participante/controle para mais de um jogador, mas sem inventar que já funciona.
- Sem automação de objetivos narrativos, NPCs, recompensas fictícias ou seguimento de Cena por IA.

## Estado
O design anterior de sessões automatizadas da Jornada deve ser ignorado. UX atual prioriza liberdade narrativa e /spawn. Mudança apenas em docs/ux da branch PR #255 Draft. Bot ativo, banco, PM2 e Baileys inalterados.
