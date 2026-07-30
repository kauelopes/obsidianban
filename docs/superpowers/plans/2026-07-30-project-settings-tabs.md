# Ajustes do projeto — navegação por abas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reestruturar o painel "Ajustes do projeto" (`ProjectPanel.tsx`) de um único modal com 6 blocos empilhados para um modal largo com navegação por abas (sidebar), isolando a zona destrutiva ("Deletar projeto") das demais tanto na navegação quanto no tratamento visual.

**Architecture:** `Dialog` ganha um prop `wide` opcional que aplica a classe CSS `.dialog.wide` (já existente em `detail.css`, hoje sem uso). `ProjectPanel` passa a manter um estado `activeTab` e renderiza um layout de duas colunas (`.settings-nav` + `.settings-content`) dentro do `Dialog`; cada uma das 5 seções existentes (Workflow, Planejamento, Agentes, Arquivamento, Zona destrutiva) vira o conteúdo de uma aba, condicionalmente renderizado. A lógica interna de cada seção (`GoalsSection`, `EpicsSection`, mint de token, form de repo, arquivar/deletar) não muda.

**Tech Stack:** React 18 + TypeScript, Vitest + @testing-library/react, CSS puro (custom properties definidas em `packages/web/src/styles/tokens.css`).

## Global Constraints

- Rodar comandos pnpm com `~/.local/share/pnpm/bin/pnpm` (não está no PATH em shells não-interativos).
- Sem comentários óbvios no código — só o "porquê" não óbvio (convenção do `CLAUDE.md`).
- Extensão `.js` obrigatória em imports relativos (NodeNext module resolution) — já é o padrão nos arquivos tocados.
- Não alterar a lógica de negócio de nenhuma seção (mint de token, set de repo, metas, épicos, arquivar, deletar) — só a casca visual/estrutural.
- Não adicionar props ou comportamento novo ao `Dialog.tsx` além do `wide` — ele é usado por outros modais do app e deve continuar funcionando neles sem mudanças.

---

### Task 1: Prop `wide` no `Dialog`

**Files:**
- Modify: `packages/web/src/ui/Dialog.tsx`
- Test: `packages/web/tests/dialog.test.tsx`

**Interfaces:**
- Produces: `Dialog` aceita um prop opcional `wide?: boolean` (default `false`); quando `true`, o elemento raiz do dialog recebe a classe `"dialog wide"` em vez de só `"dialog"`. A classe CSS `.dialog.wide { max-width: 860px; }` já existe em `packages/web/src/styles/detail.css:787` — nenhuma mudança de CSS necessária nesta task.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao final do `describe('Dialog', ...)` em `packages/web/tests/dialog.test.tsx` (depois do último `it(...)`, antes do `})` de fechamento do describe):

```tsx
  it('aplica a classe wide quando o prop wide é passado', () => {
    const { container } = render(
      <Dialog title="Título largo" onClose={() => {}} wide>
        <div />
      </Dialog>,
    )
    const dialog = container.querySelector('.dialog') as HTMLElement
    expect(dialog.classList.contains('wide')).toBe(true)
  })

  it('não aplica a classe wide por padrão', () => {
    const { container } = render(
      <Dialog title="Título normal" onClose={() => {}}>
        <div />
      </Dialog>,
    )
    const dialog = container.querySelector('.dialog') as HTMLElement
    expect(dialog.classList.contains('wide')).toBe(false)
  })
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm exec vitest run tests/dialog.test.tsx`
Expected: FAIL — o teste "aplica a classe wide..." falha porque `wide` não é uma prop reconhecida por TypeScript/o elemento nunca ganha a classe `wide` (TS pode até barrar a compilação do teste; nesse caso o erro esperado é de tipo, não de asserção — ambos confirmam que a implementação ainda não existe).

- [ ] **Step 3: Implementar o prop `wide`**

Em `packages/web/src/ui/Dialog.tsx`, mudar a assinatura da função e o `className` do dialog:

```tsx
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
```

E a linha do `className` (hoje `className="dialog"`):

```tsx
        className={`dialog${wide ? ' wide' : ''}`}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm exec vitest run tests/dialog.test.tsx`
Expected: PASS — 7 testes (os 5 originais + os 2 novos).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui/Dialog.tsx packages/web/tests/dialog.test.tsx
git commit -m "feat: Dialog aceita variante wide para modais de conteúdo mais denso"
```

---

### Task 2: CSS de navegação por abas (`.settings-layout`)

**Files:**
- Modify: `packages/web/src/styles/detail.css`

**Interfaces:**
- Produces: classes CSS que a Task 3 vai consumir no JSX de `ProjectPanel.tsx`:
  - `.settings-layout` — container flex de duas colunas (nav + content)
  - `.settings-nav` — coluna de botões de aba, ~160px
  - `.settings-nav button.active` — aba selecionada
  - `.settings-nav button.danger-tab` — aba de risco (texto na cor `--alert`)
  - `.settings-content` — coluna de conteúdo da aba ativa, `flex: 1`
  - Abaixo de 640px de largura, `.settings-nav` vira uma lista horizontal rolável no topo em vez de coluna lateral.

Esta task não tem teste automatizado próprio (é CSS puro, sem framework de regressão visual no repo) — a verificação real acontece na Task 3, quando o JSX passa a usar essas classes e os testes de `ProjectPanel` conseguem localizar os elementos por role/texto. Ainda assim, cada passo abaixo é uma edição isolada e revisável.

- [ ] **Step 1: Adicionar as classes ao final da seção "Dialog" em `detail.css`**

Abrir `packages/web/src/styles/detail.css`, localizar o bloco `.dialog > footer .left { margin-right: auto; }` (por volta da linha 828-830) e adicionar logo depois:

```css
/* ── Ajustes do projeto: navegação por abas ──────────────────────────────── */

.settings-layout {
  display: flex;
  gap: var(--s-6);
  align-items: flex-start;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  flex: 0 0 160px;
}

.settings-nav button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 1px solid transparent;
  color: var(--fg-1);
  font-size: var(--t-sm);
}

.settings-nav button:hover:not(:disabled) {
  background: var(--ink-2);
  color: var(--fg-0);
}

.settings-nav button.active {
  background: var(--ink-2);
  border-color: var(--rule-strong);
  color: var(--fg-0);
  font-weight: 600;
}

.settings-nav button.danger-tab {
  color: var(--alert);
}

.settings-nav button.danger-tab.active {
  background: var(--alert-weak);
  border-color: color-mix(in srgb, var(--alert) 45%, var(--rule));
}

.settings-content {
  flex: 1;
  min-width: 0;
}

@media (max-width: 640px) {
  .settings-layout {
    flex-direction: column;
  }

  .settings-nav {
    flex-direction: row;
    flex: 0 0 auto;
    width: 100%;
    gap: var(--s-3);
    overflow-x: auto;
    padding-bottom: var(--s-3);
    border-bottom: 1px solid var(--rule);
  }

  .settings-nav button {
    width: auto;
    white-space: nowrap;
  }
}
```

- [ ] **Step 2: Confirmar que o build do web não quebra**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm run build`
Expected: build termina sem erro (CSS solto não quebra o build do Vite; este passo é só para garantir que não há erro de sintaxe no arquivo).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/styles/detail.css
git commit -m "feat: CSS de navegação por abas para o painel de ajustes do projeto"
```

---

### Task 3: Reestruturar `ProjectPanel` em abas

**Files:**
- Modify: `packages/web/src/ui/ProjectPanel.tsx`
- Test: `packages/web/tests/project-panel.test.tsx`

**Interfaces:**
- Consumes: `Dialog` com o novo prop `wide` (Task 1); classes `.settings-layout`, `.settings-nav`, `.settings-content`, `.active`, `.danger-tab` (Task 2).
- Produces: nenhuma interface nova para fora do componente — `ProjectPanel` continua com a mesma assinatura de props (`client`, `project`, `onClose`, `onChanged`). `GoalsSection`, `EpicsSection`, `Readiness`, `EnvLine`, `TokenOnce` continuam exportados/definidos exatamente como hoje, só realocados na árvore de renderização do `return` principal.

- [ ] **Step 1: Reescrever `packages/web/tests/project-panel.test.tsx` refletindo a navegação por abas**

Substituir todo o conteúdo do arquivo por:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { KanbanClient } from '../src/api/client.js'
import { ProjectPanel } from '../src/ui/ProjectPanel.js'

function stubClient(overrides: Partial<KanbanClient> = {}): KanbanClient {
  const base = {
    listProjects: () =>
      Promise.resolve({
        ok: true as const,
        data: { projects: [{ project: 'teste', goals: [] }] },
      }),
    listEpics: () => Promise.resolve({ ok: true as const, data: { project: 'teste', epics: [] } }),
    setProjectRepo: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
    createAgentToken: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
    deleteProject: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    archiveProject: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    unarchiveProject: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    ...overrides,
  }
  return base as unknown as KanbanClient
}

function renderPanel(client: KanbanClient = stubClient()) {
  return render(
    <ProjectPanel client={client} project="teste" onClose={() => {}} onChanged={() => {}} />,
  )
}

describe('ProjectPanel', () => {
  it('renderiza as 5 abas na sidebar, na ordem esperada', () => {
    renderPanel()
    const nav = screen.getByRole('navigation')
    const labels = [...nav.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual([
      'Workflow',
      'Planejamento',
      'Agentes',
      'Arquivamento',
      'Deletar projeto',
    ])
  })

  it('abre na aba Workflow por padrão', () => {
    renderPanel()
    expect(screen.getByText('Repositório do workflow')).toBeInTheDocument()
    expect(screen.queryByText('Metas do projeto')).not.toBeInTheDocument()
  })

  it('clicar numa aba troca o conteúdo exibido', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Planejamento' }))
    expect(screen.getByText('Metas do projeto')).toBeInTheDocument()
    expect(screen.queryByText('Repositório do workflow')).not.toBeInTheDocument()
  })

  it('a aba Deletar projeto tem classe própria de risco', () => {
    renderPanel()
    const dangerTab = screen.getByRole('button', { name: 'Deletar projeto' })
    expect(dangerTab.classList.contains('danger-tab')).toBe(true)
  })

  it('deletar continua bloqueado até o nome do projeto ser digitado corretamente', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Deletar projeto' }))
    const deleteButton = screen.getByRole('button', { name: 'Deletar' }) as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    const input = screen.getByPlaceholderText('digite “teste” para confirmar')
    fireEvent.change(input, { target: { value: 'errado' } })
    expect(deleteButton.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'teste' } })
    expect(deleteButton.disabled).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm exec vitest run tests/project-panel.test.tsx`
Expected: FAIL em todos os 5 testes — o componente ainda renderiza todas as seções empilhadas, sem `<nav>`, sem classe `danger-tab`, e "Metas do projeto" já está visível junto com "Repositório do workflow" desde o início.

- [ ] **Step 3: Reescrever o `return` de `ProjectPanel` com estado de aba**

Em `packages/web/src/ui/ProjectPanel.tsx`, adicionar logo abaixo dos imports existentes (depois da linha `import { Dialog } from './Dialog.js'`):

```tsx
const TABS = [
  { key: 'workflow', label: 'Workflow' },
  { key: 'planning', label: 'Planejamento' },
  { key: 'agents', label: 'Agentes' },
  { key: 'archive', label: 'Arquivamento' },
  { key: 'danger', label: 'Deletar projeto', danger: true },
] as const

type TabKey = (typeof TABS)[number]['key']
```

Dentro do componente `ProjectPanel`, adicionar o novo estado junto aos `useState` existentes (logo após `const [repo, setRepo] = useState('')`):

```tsx
  const [activeTab, setActiveTab] = useState<TabKey>('workflow')
```

Substituir todo o bloco `return (...)` do componente `ProjectPanel` (do `return (` na linha ~82 até o `)` que fecha o `Dialog`, por volta da linha ~196) por:

```tsx
  return (
    <Dialog title={`Ajustes — ${project}`} onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Seções de ajuste">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={[activeTab === t.key && 'active', t.danger && 'danger-tab']
                .filter(Boolean)
                .join(' ')}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {error && <p className="banner">{error}</p>}
          {note && <p className="field-help">{note}</p>}

          {activeTab === 'workflow' && (
            <section className="panel-section">
              <h3>Workflow</h3>
              <div className="form">
                <label>
                  <span>Repositório do workflow</span>
                  <input
                    className="mono"
                    value={repo}
                    placeholder="/caminho/absoluto/para/o/repo"
                    onChange={(e) => setRepo(e.target.value)}
                  />
                  <span className="field-help">
                    É o diretório de trabalho do sprint workflow. Ao definir, o servidor instala
                    as skills, escreve os configs e gera os tokens de pm e dev que faltarem — eles
                    aparecem abaixo uma única vez.
                  </span>
                </label>
                <div className="form-row">
                  <button
                    className="primary"
                    disabled={busy || !repo.trim()}
                    onClick={() => setRepoPath(repo.trim())}
                  >
                    Definir repositório
                  </button>
                  <button disabled={busy} onClick={() => setRepoPath(null)}>
                    Remover repositório
                  </button>
                </div>
              </div>

              {readiness && <Readiness r={readiness} />}
            </section>
          )}

          {activeTab === 'planning' && (
            <section className="panel-section">
              <h3>Planejamento do projeto</h3>
              <GoalsSection client={client} project={project} onChanged={onChanged} setError={setError} />
              <EpicsSection client={client} project={project} onChanged={onChanged} setError={setError} />
            </section>
          )}

          {activeTab === 'agents' && (
            <section className="panel-section">
              <h3>Agentes e tokens</h3>
              <div className="form">
                <label>
                  <span>Novo token de agente</span>
                  <div className="form-row">
                    <input
                      value={actor}
                      placeholder="actor (ex. dev-claude)"
                      onChange={(e) => setActor(e.target.value)}
                    />
                    <select
                      aria-label="Tipo de agente"
                      value={agentType}
                      onChange={(e) => setAgentType(e.target.value === 'pm' ? 'pm' : 'dev')}
                    >
                      <option value="dev">dev — só log</option>
                      <option value="pm">pm — acesso completo</option>
                    </select>
                    <button disabled={busy || !actor.trim()} onClick={mint}>
                      Gerar token
                    </button>
                  </div>
                  <span className="field-help">
                    O CLI <code>kanban-token</code> grava sempre <code>agent_type: pm</code>; esta
                    é a única via para um token dev de verdade.
                  </span>
                </label>
              </div>

              {minted && <TokenOnce t={minted} />}
            </section>
          )}

          {activeTab === 'archive' && (
            <section className="panel-section">
              <h3>Arquivamento</h3>
              <div className="form-row">
                <button disabled={busy} onClick={() => void client.archiveProject({ project }).then(onChanged)}>
                  Arquivar projeto
                </button>
                <button
                  disabled={busy}
                  onClick={() => void client.unarchiveProject({ project }).then(onChanged)}
                >
                  Desarquivar
                </button>
              </div>
            </section>
          )}

          {activeTab === 'danger' && (
            <section className="panel-section panel-section--danger">
              <h3>Zona destrutiva</h3>
              <label>
                <span>Deletar projeto — permanente</span>
                <div className="form-row">
                  <input
                    className="mono"
                    value={confirmText}
                    placeholder={`digite “${project}” para confirmar`}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                  <button
                    className="danger"
                    disabled={busy || confirmText !== project}
                    onClick={removeProject}
                  >
                    Deletar
                  </button>
                </div>
                <span className="field-help">
                  Apaga a pasta do projeto e todos os seus cards. Não há desfazer.
                </span>
              </label>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  )
```

Não mexer em mais nada no arquivo: `GoalsSection`, `EpicsSection`, `Readiness`, `EnvLine`, `TokenOnce` e todas as funções internas (`setRepoPath`, `mint`, `removeProject`) continuam exatamente como estão hoje.

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm exec vitest run tests/project-panel.test.tsx`
Expected: PASS — 5 testes.

- [ ] **Step 5: Rodar a suíte inteira do pacote web para checar por regressão**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm exec vitest run`
Expected: PASS em todos os arquivos de teste do pacote (inclui `dialog.test.tsx`, `project-panel.test.tsx`, `board.test.tsx`, `render.test.tsx`, `tape.test.tsx`, etc.) — nenhum outro arquivo referencia `.panel-section` ou a estrutura antiga de `ProjectPanel`.

- [ ] **Step 6: Typecheck**

Run: `cd packages/web && ~/.local/share/pnpm/bin/pnpm run typecheck`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/ui/ProjectPanel.tsx packages/web/tests/project-panel.test.tsx
git commit -m "feat: painel de ajustes do projeto vira navegação por abas com sidebar"
```

---

### Task 4: Verificação manual no navegador

**Files:** nenhum arquivo tocado — apenas verificação visual.

- [ ] **Step 1: Subir o servidor e o dev do web**

Seguir o fluxo padrão do repo (ver `CLAUDE.md`): definir `VAULT_PATH` e `MCP_HTTP_PORT`, rodar `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev` e, em outro terminal, `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web run dev`.

- [ ] **Step 2: Abrir o painel de ajustes de um projeto existente no navegador**

Confirmar visualmente:
- O modal abre mais largo que antes e mostra a sidebar de 5 abas à esquerda, "Workflow" ativa.
- Clicar em cada uma das outras 4 abas troca o conteúdo corretamente, sem sobreposição com as demais.
- A aba "Deletar projeto" aparece com o texto em vermelho (`--alert`) na sidebar, distinta das outras 4.
- Redimensionar a janela do navegador para menos de 640px de largura: a sidebar vira uma lista horizontal rolável no topo em vez de coluna lateral.
- O fluxo de deletar projeto (digitar o nome, botão habilitar) continua funcionando dentro da aba.

- [ ] **Step 3: Reportar ao usuário**

Confirmar ao usuário que a verificação manual passou, ou descrever o que não bateu com o esperado antes de considerar a task concluída.

---

## Self-Review Notes

- **Cobertura do spec:** as 5 abas, a aba padrão (Workflow), o destaque visual da aba de risco, o erro/nota único no topo do `.settings-content`, o breakpoint responsivo e o prop `wide` do `Dialog` estão todos cobertos (Tasks 1–3). A verificação manual (Task 4) cobre o que os testes automatizados não alcançam (aparência real, comportamento do breakpoint em viewport real).
- **Teste do banner de erro por aba:** não foi adicionado um teste automatizado dedicado para "trocar de aba não limpa o erro" porque isso já era o comportamento herdado (estado único `error`/`note` no componente pai) e nenhuma mudança de lógica foi feita nele — só reposicionado no JSX. Coberto por inspeção de código na Task 3, não por um teste novo.
- **Sem placeholders:** todos os steps têm código completo, sem "TBD" nem "similar to Task N".
