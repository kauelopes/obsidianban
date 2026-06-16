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
│   ├── server/          # MCP Server — Node.js, TypeScript, better-sqlite3
│   │   ├── src/         # Código fonte (39 arquivos TypeScript)
│   │   ├── tests/       # Testes vitest (unit/, service/, integration/)
│   │   └── dist/        # Output compilado (gitignored)
│   ├── plugin/          # Plugin Obsidian — TypeScript + esbuild
│   │   └── src/         # Código fonte (25 arquivos TypeScript)
│   └── shared/          # Tipos compartilhados (@obsidiankan/types)
│       └── src/index.ts # Fonte de verdade dos tipos do domínio
├── scripts/             # sprint-workflow.ts e scripts auxiliares
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

# Compilar plugin Obsidian (esbuild)
~/.local/share/pnpm/bin/pnpm run build:plugin

# Compilar pacote específico
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp build
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/plugin build
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/types build
```

**Ordem de build:** `shared` → `server` (o server depende dos tipos do shared).

---

## Modo desenvolvimento

```bash
# Server com hot reload (tsx watch)
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev

# Plugin com watch mode (recompila ao salvar)
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/plugin run dev
```

Para o plugin dev, configure o vault de desenvolvimento:
```bash
export OBSIDIANKAN_DEV_VAULT=/caminho/para/test-vault
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/plugin run dev
```

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

## Docker

```bash
# Build da imagem
docker build -t obsidiankan .

# Rodar com volume do vault
docker run -d \
  -v /caminho/para/vault:/vault \
  -p 9375:9375 \
  -e VAULT_PATH=/vault \
  -e LOG_LEVEL=debug \
  --name obsidiankan \
  obsidiankan

# Ver logs
docker logs -f obsidiankan
```

A imagem usa build multi-stage: builder (compila TypeScript) → runtime (só dependências de produção). Usuário `node` (uid 1000) para compatibilidade com Podman rootless.

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
| `pnpm run build:plugin` | Compila plugin |
| `pnpm run test` | Roda testes uma vez |
| `pnpm run test:watch` | Testes em watch mode |
| `pnpm run test:coverage` | Testes + relatório de cobertura |
| `pnpm run typecheck` | Verifica tipos de todos os pacotes |
| `pnpm run gen:tools` | Regenera catálogo de tools |
