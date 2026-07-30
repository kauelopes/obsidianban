# Ajustes do projeto — navegação por abas (design)

## Problema

O painel de ajustes do projeto (`packages/web/src/ui/ProjectPanel.tsx`) empilha 6 blocos num único modal estreito (620px, classe `.dialog` padrão): Workflow, Planejamento (metas + épicos), Agentes/tokens, Arquivamento e Zona destrutiva. Todos os blocos usam o mesmo tratamento visual (`.panel-section` com título mono + borda inferior), então não há hierarquia entre uma ação de rotina (adicionar meta) e uma ação rara e perigosa (deletar o projeto). O usuário relatou a tela como "feia, desorganizada".

## Objetivo

Dar hierarquia estrutural à tela: transformar o empilhamento vertical em navegação por abas com sidebar, isolando a zona destrutiva das demais tanto na navegação quanto visualmente.

## Estrutura

`ProjectPanel` passa a renderizar `<Dialog>` usando a variante larga já existente (`.dialog.wide`, 860px em `detail.css:787`) com um layout interno de duas colunas:

- **Sidebar de navegação** (`.settings-nav`, ~160px): lista vertical de botões, um por aba.
- **Conteúdo** (`.settings-content`, flex: 1): renderiza apenas a aba ativa.

Estado local `activeTab` (`'workflow' | 'planning' | 'agents' | 'archive' | 'danger'`) controla qual seção aparece. As seções existentes (`GoalsSection`, `EpicsSection`, o form de mint de token, `Readiness`, o form de repo, arquivar/desarquivar, o form de deletar) mantêm o JSX e a lógica atuais — só são movidas para dentro de um mapa/`switch` por aba em vez de ficarem todas empilhadas no mesmo `return`.

### As 5 abas, na ordem da sidebar

1. **Workflow** — repositório do sprint workflow + `Readiness`. Aba padrão ao abrir o painel.
2. **Planejamento** — metas (`GoalsSection`) + épicos (`EpicsSection`).
3. **Agentes** — mint de token de agente (pm/dev).
4. **Arquivamento** — arquivar/desarquivar o projeto.
5. **Deletar projeto** — a zona destrutiva atual (`panel-section--danger`), isolada em sua própria aba.

### Peso visual por risco

O item "Deletar projeto" na sidebar recebe tratamento distinto (`.settings-nav button.danger-tab`: cor de texto `--alert`) para se destacar como diferente das outras 4 antes mesmo do clique. As outras 4 abas têm o mesmo peso visual entre si — não há hierarquia adicional entre Workflow/Planejamento/Agentes/Arquivamento.

## Erro e nota

Mantém-se um único estado de `error`/`note` no nível do `ProjectPanel` (como hoje), mas a exibição migra para o topo do `.settings-content`, acima da aba ativa — não duplicado por aba. Trocar de aba não limpa o erro automaticamente (comportamento atual mantido: o erro só é limpo no início da próxima ação/mutação).

## Responsividade

Abaixo do breakpoint estreito já usado em `detail.css` para outros componentes do dialog, `.settings-nav` deixa de ser coluna lateral e vira uma lista horizontal rolável no topo do `.settings-content` (mesmo padrão de abas, sem sidebar fixa) para não quebrar em telas pequenas.

## Arquivos tocados

- `packages/web/src/ui/ProjectPanel.tsx` — estado de aba ativa + reestruturação do JSX de retorno. `GoalsSection`, `EpicsSection`, `Readiness`, `EnvLine`, `TokenOnce` permanecem como estão (apenas realocados na árvore de renderização).
- `packages/web/src/styles/detail.css` — novas classes `.settings-layout`, `.settings-nav`, `.settings-nav button`, `.settings-nav button.active`, `.settings-nav button.danger-tab`, `.settings-content`, e ajuste no breakpoint estreito existente. `.panel-section` deixa de precisar da borda-inferior-de-lista quando usado dentro de `.settings-content` (só uma seção visível por vez).

## Fora de escopo

- Não altera o componente `Dialog.tsx` genérico (usado por outros modais) além de já usar a classe `wide` que ele já suporta.
- Não altera a lógica de negócio de nenhuma das seções (mint de token, set de repo, metas, épicos, arquivar, deletar) — só a casca visual/estrutural.
- Não adiciona testes de layout novos; os testes existentes de `ProjectPanel` (se houver) precisam continuar selecionando elementos pelo texto/role, não por estrutura de DOM — checar se algum teste depende de todas as seções estarem simultaneamente no DOM (precisaria trocar de aba para asserir sobre seções não-ativas).
