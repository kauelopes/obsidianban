# Crítica Codex — qualidade e diagramação do projeto

Data da análise: 2026-07-28.

Esta crítica considera a árvore atual do repositório, incluindo arquivos modificados e não versionados. O foco é avaliar a qualidade do projeto como produto técnico e, principalmente, apontar melhorias de diagramação, arquitetura de informação e experiência de uso.

## Diagnóstico geral

O ObsidianKan está em um estágio acima de protótipo. A arquitetura central é coerente: o servidor MCP é a autoridade, o vault Markdown continua sendo a fonte legível por humanos, o SQLite é índice derivado, e a web app evoluiu para cliente HTTP/SSE sem replicar regra de negócio crítica. Essa separação é uma das forças do projeto.

A documentação também é mais madura que a média. Há PRD, handoff, guias por público, runbooks para agentes e registros de decisões conscientes. Isso reduz perda de contexto entre sessões e deixa claro por que certas escolhas existem, como o plugin congelado como rollback e o servidor como única autoridade.

A UI atual tem uma direção visual forte: interface operacional densa, sem aparência de landing page, com tokens próprios, tipografia intencional e cor reservada para estado. A Home como hub de supervisão é uma decisão correta, porque o produto não é só um board; ele é um painel para humanos coordenarem trabalho com agentes.

O principal problema não é falta de capricho. O problema é que o produto cresceu em muitas frentes ao mesmo tempo: board, supervisão, atividade, planejamento, administração de projeto, tokens, metas, épicos e workflow. A diagramação ainda não separa com força suficiente o que é operação diária, o que é configuração, o que é risco destrutivo e o que é supervisão executiva.

## Pontos fortes

- **Arquitetura técnica clara:** `server`, `web`, `shared` e `plugin` têm responsabilidades compreensíveis. O cliente web consome HTTP/SSE e não tenta virar fonte de verdade.
- **Bom tratamento de consistência:** optimistic locking, idempotência, audit log, reconciliação e SSE aparecem como conceitos de produto, não só implementação.
- **Design visual com tese:** autoria não usa cor, estado usa cor, dados de máquina usam mono, prosa humana usa serif. Essa tese é consistente e dá identidade ao sistema.
- **Home reposicionada corretamente:** sair do board global empilhado e ir para um hub de supervisão reduz ruído quando há múltiplos projetos.
- **Documentação de handoff útil:** o arquivo `docs/handoff-fase4-ui.md` registra decisões, ressalvas e armadilhas reais. Isso é valioso para continuidade.
- **Testes razoáveis:** há testes web, server e plugin, além de fixtures e cobertura de comportamento importante. O projeto não depende apenas de teste manual.

## Críticas principais

### 1. Arquitetura de informação

A topbar concentra muitas funções de naturezas diferentes: navegação primária, planejamento, criação de projeto, estado de conexão, tema e logout. Em uma interface operacional, isso cria competição visual constante. A navegação deveria responder "onde estou"; ações como criar projeto ou continuar planejamento deveriam ser contextuais ou agrupadas em uma área de ações.

A Home está no caminho certo, mas precisa continuar sendo tratada como painel de decisão, não como página de resumo genérico. A ordem "precisa de você" → projetos → uso é boa. O risco é a página passar a acumular novos widgets sem uma regra forte de prioridade.

Recomendação: definir uma hierarquia fixa para cada rota:

- Topbar: identidade, navegação primária e estado global mínimo.
- Cabeçalho da página: ações contextuais da rota.
- Corpo: decisão principal da rota.
- Áreas secundárias: métricas, detalhes e atalhos.

### 2. Board e fluxo operacional

O board melhorou ao ser escopado por projeto e usar colunas fluidas. Isso reduziu a confusão do board global. Ainda assim, a operação essencial depende demais de ponteiro: mover e reordenar cards são funções centrais e precisam funcionar por teclado.

Também falta tornar o reorder mais explícito. Hoje o card inteiro é clicável e arrastável, o que resolve uma dor anterior, mas deixa a intenção ambígua: clicar abre, arrastar move, soltar sobre card reordena. Para usuários novos, essa gramática é poderosa, mas pouco visível.

Recomendação:

- Implementar `KeyboardSensor` no `dnd-kit`.
- Adicionar anúncios acessíveis para início, destino e conclusão de drag.
- Considerar uma alça visual discreta de drag quando o card estiver em foco ou hover.
- Manter o clique no card inteiro, mas separar visualmente "abrir" e "mover" para usuários de teclado.

### 3. Cards e densidade visual

A linha de metadados dos cards é útil, mas pode ficar ruidosa quando vários sinais aparecem juntos: id, prioridade, prazo, responsável, bloqueio, arquivado e escalação. O projeto já tem uma boa regra de cor, mas ainda falta uma regra de densidade.

Nem todo dado precisa aparecer com o mesmo peso no card. Escalação, atraso crítico e bloqueio mudam a ação humana imediata. Id, responsável e tags ajudam rastreio, mas não deveriam competir visualmente com estados de decisão.

Recomendação:

- Definir uma matriz de visibilidade: sempre visível, visível quando relevante, visível em hover/focus, visível só no detalhe.
- Fazer escalação e review dominarem a leitura do card.
- Rebaixar metadados administrativos quando houver alerta humano.
- Limitar tags no board e deixar o detalhe carregar a taxonomia completa.

### 4. Modais e acessibilidade

O componente `Dialog` é simples e consistente, mas ainda está abaixo do nível esperado para uma ferramenta operacional. Ele fecha com Escape e clique no overlay, porém não prende foco, não restaura foco ao elemento que abriu o modal e não usa um padrão robusto para navegação por teclado.

O botão de fechar usa `×`, que funciona visualmente, mas deveria seguir o mesmo padrão de botões simbólicos com nome acessível e tratamento consistente. O projeto já usa `aria-label` em alguns pontos, mas ainda não há uma política uniforme.

Recomendação:

- Implementar focus trap em todos os dialogs.
- Restaurar foco ao disparador ao fechar.
- Garantir `aria-labelledby` no dialog.
- Padronizar botões de fechar, remover, voltar e adicionar.
- Cobrir navegação por teclado em testes de render quando viável.

### 5. Painel de ajustes do projeto

O `ProjectPanel` junta tarefas com riscos e frequências muito diferentes: repositório do workflow, readiness, metas, épicos, tokens, arquivar e deletar. Essa mistura é perigosa porque ações raras e destrutivas convivem com ações recorrentes.

A crítica aqui é de diagramação e segurança operacional. "Gerar token" e "deletar projeto" não deveriam parecer apenas duas seções de um formulário longo. O usuário precisa perceber claramente que entrou em uma zona administrativa.

Recomendação:

- Separar o painel em blocos com títulos mais fortes: Workflow, Planejamento do projeto, Agentes e tokens, Arquivamento, Zona destrutiva.
- Colocar a zona destrutiva no final com borda, espaçamento e confirmação visual próprios.
- Evitar `hr` inline como principal separador. Criar classes CSS semânticas para seções administrativas.
- Considerar transformar ajustes em página dedicada se o conteúdo continuar crescendo.

### 6. Planejamento

O wizard de planejamento já corrigiu um problema importante: 15 etapas não viraram breadcrumb ilegível; agora há fase e contagem. Ainda assim, a tela mistura três ações cognitivamente diferentes: responder a etapa, pedir correção e materializar projeto.

"Corrigir" é uma conversa com o gerador. "Continuar" é aceitar a etapa. "Materializar" altera o vault e cria estrutura. A diagramação deve deixar essa escalada de risco muito clara.

Recomendação:

- Dar mais peso visual ao CTA de materialização do que ao CTA de etapa comum.
- Diferenciar área de refinamento como comentário/correção, não como ação primária.
- Mostrar, antes de materializar, um resumo curto do que será criado.
- Manter custo/tokens no rodapé, mas sem competir com a decisão principal.

### 7. Responsividade

O CSS já mostra preocupação com larguras (`--w-read`, `--w-wide`, `--w-board`) e colunas fluidas. Ainda assim, a topbar e os painéis densos podem degradar em viewports menores. O board tem rolagem horizontal por projeto, mas a navegação e as ações podem continuar apertadas.

Recomendação:

- Testar Home, Board, Card Detail, Inbox, Atividade e Wizard em larguras pequenas e médias.
- Criar comportamento responsivo explícito para topbar: colapsar ações contextuais antes da navegação.
- Garantir que botões com texto longo não comprimam seleção de projeto, busca ou estado de conexão.
- Registrar screenshots reais como evidência, não apenas passar em `jsdom`.

### 8. Consistência visual

O sistema de tokens é forte, mas ainda há muitos símbolos textuais soltos: `+`, `←`, `→`, `◇`, `▲`, `●`, `✓`, `×`. Alguns são semânticos, outros são atalhos visuais. O risco é o vocabulário visual virar uma coleção de exceções.

Também há uso de `letter-spacing` em labels mono. Isso pode funcionar como estética de painel técnico, mas precisa ser validado em legibilidade, especialmente em tamanhos pequenos.

Recomendação:

- Criar um pequeno inventário de símbolos permitidos e seus significados.
- Trocar símbolos de ação por ícones ou botões padronizados quando a ação for comando, não estado.
- Manter glifos para eventos do Agent Log, onde eles têm função semântica.
- Revisar labels muito pequenas em telas densas.

### 9. Documentação e estado do plugin

A documentação ainda preserva muito contexto do plugin, o que é compreensível porque ele é rollback natural. Mas, se a fase 5 avançar, a documentação precisa reposicionar a web como superfície primária e o plugin como legado/removido.

Há risco de uma nova sessão seguir documentação antiga e reabrir decisões que já foram fechadas no handoff. O próprio handoff pede cuidado com isso.

Recomendação:

- Antes de remover o plugin, listar fluxos ainda exclusivos dele, se houver.
- Depois da remoção, atualizar README, arquitetura, config e guias de usuário.
- Mover material histórico para archive, mantendo apenas decisões vivas na documentação principal.

### 10. Testes e verificação visual

O projeto tem boa base de testes, mas algumas garantias importantes ainda dependem de verificação manual: MathJax em tela real, SSE de ponta a ponta, conflito 409 renderizado e comportamento visual em browser. O handoff registra isso explicitamente.

Para uma interface dessa natureza, `jsdom` não basta. A qualidade da diagramação precisa ser medida em browser real, em tema claro e escuro, com dados representativos.

Recomendação:

- Adotar Playwright ou rotina equivalente para screenshots das rotas principais.
- Testar navegação por teclado em modais, board e wizard.
- Criar fixture visual com cards em estados extremos: escalado, bloqueado, atrasado, arquivado, muitos tags, título longo e sprint encerrada.
- Registrar quando uma mudança visual foi verificada apenas por teste automatizado e quando foi verificada em browser.

## Prioridades recomendadas

### P0 — Acessibilidade estrutural

- Focus trap e retorno de foco nos dialogs.
- Drag-and-drop por teclado.
- Anúncios acessíveis para reorder/move.
- Revisão de `aria-label`, `aria-labelledby` e botões simbólicos.

Esses itens são prioridade porque afetam acesso básico e confiabilidade operacional, não apenas estética.

### P1 — Reorganização de administração

- Redesenhar `ProjectPanel`.
- Isolar zona destrutiva.
- Agrupar workflow, metas/épicos e tokens por intenção.
- Reduzir dependência de separadores genéricos.

Esse painel concentra ações de alto impacto e merece diagramação mais defensiva.

### P1 — Topbar e ações contextuais

- Diminuir competição visual na barra superior.
- Mover ações de página para cabeçalhos locais.
- Preservar topbar para navegação e estado global.

Isso deve melhorar a sensação de produto profissional e reduzir carga cognitiva.

### P1 — Densidade dos cards

- Definir regra de sinais sempre visíveis.
- Rebaixar metadados administrativos.
- Garantir que escalação/review dominem visualmente.

O board é a superfície operacional mais frequente; pequenos ruídos ali se acumulam.

### P2 — Verificação visual recorrente

- Screenshots reais por rota.
- Tema claro/escuro.
- Larguras pequenas, médias e grandes.
- Casos extremos de dados.

Isso evita regressões que testes unitários não capturam.

### P2 — Atualização documental pós-plugin

- Reposicionar a web como superfície principal.
- Arquivar documentação obsoleta do plugin.
- Atualizar guias de usuário e arquitetura.

Isso reduz fricção para próximas sessões e novos contribuidores.

## Critério de sucesso para a próxima iteração visual

A próxima melhoria de diagramação deve ser considerada pronta apenas se cumprir estes pontos:

- A pessoa consegue operar Home, Board, Card Detail e Wizard sem mouse.
- Modais não deixam o foco escapar e devolvem foco ao fechar.
- Ações destrutivas não parecem ações comuns.
- A topbar não vira depósito de ações contextuais.
- Cards em estados críticos continuam legíveis mesmo com muitos metadados.
- Há evidência visual em browser real para pelo menos tema claro e escuro.

## Conclusão

O projeto tem uma base técnica e visual boa. A crítica principal é de maturidade de produto: a interface precisa separar melhor decisão, operação, configuração e risco. A direção atual é correta, mas a próxima etapa deve ser menos sobre adicionar telas e mais sobre tornar cada tela defensável sob pressão: muitos cards, muitos projetos, agentes trabalhando, conflitos reais e um humano tomando decisões rápidas.

