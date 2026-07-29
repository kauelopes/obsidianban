# Setup para Desenvolvimento — ObsidianKan

Guia completo para configurar o ambiente de desenvolvimento local.

---

## Requisitos

| Ferramenta | Versão | Notas |
|---|---|---|
| Node.js | ≥ 22 | Necessário para `using` declarations e APIs recentes |
| pnpm | qualquer | Gerenciador de pacotes do monorepo |
| TypeScript | 5.6 (instalado como dep) | Não precisa instalar globalmente |

```bash
# Verificar versões
node --version   # v22.x.x
~/.local/share/pnpm/bin/pnpm --version

# pnpm não encontrado:
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

> Em shells não-interativos (scripts, hooks), use o path completo: `~/.local/share/pnpm/bin/pnpm`

---

## Estrutura do Monorepo

```
obsidiankan/
├── packages/
│   ├── server/          # MCP Server — Node.js, TypeScript, better-sqlite3 (serve o web app na mesma origem)
│   │   ├── src/         # Código fonte
│   │   ├── scripts/     # sprint-workflow.ts — orquestrador autônomo
│   │   ├── tests/       # Testes vitest (unit/, service/, integration/)
│   │   └── dist/        # Output compilado (gitignored)
│   ├── web/             # Web app — React + Vite + TypeScript
│   │   └── src/         # Código fonte (board, card detail, wizard de planejamento)
│   └── shared/          # Tipos compartilhados (@obsidiankan/types)
│       └── src/index.ts # Fonte de verdade dos tipos do domínio
├── docs/                # Documentação (esta pasta)
└── pnpm-workspace.yaml  # Configuração do workspace
```

---

## Instalação

```bash
git clone <repo-url> obsidiankan
cd obsidiankan

# Instala dependências de todos os pacotes
~/.local/share/pnpm/bin/pnpm install
```

---

## Build

```bash
# Compilar server + shared (ordem correta via project references)
~/.local/share/pnpm/bin/pnpm run build

# Compilar web app (Vite)
~/.local/share/pnpm/bin/pnpm run build:web

# Compilar pacote específico
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp build
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web build
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/types build
```

**Ordem de build:** `shared` → `server` (o server depende dos tipos do shared).

---

## Modo desenvolvimento

```bash
# Server com hot reload (tsx watch)
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev

# Web app com hot reload (Vite dev server, proxied para o servidor kanban)
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web run dev
```

Em `vite dev` não há sessão injetada — o gate de token aparece, e isso é esperado: só o `index.html` servido pelo **servidor** (build de produção) recebe a injeção.

---

## Type checking

```bash
# Verificar todos os pacotes
~/.local/share/pnpm/bin/pnpm run typecheck

# Pacote específico
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run typecheck
```

---

## Testes

Veja o guia completo em [`testing.md`](testing.md).

```bash
# Rodar todos os testes
~/.local/share/pnpm/bin/pnpm run test

# Watch mode
~/.local/share/pnpm/bin/pnpm run test:watch

# Cobertura
~/.local/share/pnpm/bin/pnpm run test:coverage
```

---

## Gerar documentação de tools

O catálogo de tools MCP é auto-gerado a partir do código:

```bash
~/.local/share/pnpm/bin/pnpm run gen:tools
# Gera: docs/for-agents/tool-catalog.md
```

Execute após qualquer alteração em `packages/server/src/server/tool-catalog.ts` ou `tool-schemas.ts`.

---

## Scripts úteis

| Comando | O que faz |
|---|---|
| `pnpm run build` | Compila server + shared |
| `pnpm run build:web` | Compila o web app |
| `pnpm run test` | Roda testes uma vez |
| `pnpm run test:watch` | Testes em watch mode |
| `pnpm run test:coverage` | Testes + relatório de cobertura |
| `pnpm run typecheck` | Verifica tipos de todos os pacotes |
| `pnpm run gen:tools` | Regenera catálogo de tools |
