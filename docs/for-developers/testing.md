# Guia de Testes — ObsidianKan

O servidor usa [Vitest](https://vitest.dev/) com 267 testes distribuídos em unit, service e integration.

---

## Como rodar

```bash
# Todos os testes (uma vez)
~/.local/share/pnpm/bin/pnpm run test

# Watch mode (reexecuta ao salvar)
~/.local/share/pnpm/bin/pnpm run test:watch

# Relatório de cobertura
~/.local/share/pnpm/bin/pnpm run test:coverage
# → gera coverage/ com relatório HTML

# Pacote específico
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run test
```

---

## Estrutura dos testes

```
packages/server/tests/
├── helpers/            # Utilitários compartilhados
│   ├── db.ts           # Setup/teardown de banco de teste (in-memory SQLite)
│   ├── factories.ts    # Factories para criar Card, Sprint, Project, etc.
│   ├── http.ts         # Client HTTP para testes de integração
│   └── vault.ts        # Setup de vault temporário em /tmp
├── unit/               # Testes de unidades isoladas
│   ├── atomic.test.ts         # Escritas atômicas
│   ├── errors.test.ts         # Tipos de erro customizados
│   ├── layout.test.ts         # Estrutura de pastas do vault
│   ├── serialize.test.ts      # Serialização de cards para Markdown
│   ├── slug.test.ts           # Geração de slugs de card
│   ├── tool-access.test.ts    # Matriz de acesso RBAC por token type
│   ├── tool-catalog.test.ts   # Metadados e descrições das tools
│   ├── tool-schemas.test.ts   # JSON Schema de cada tool
│   ├── validation.test.ts     # Validação de campos de card
│   └── auth.test.ts           # Validação de tokens
├── service/            # Testes de serviços com banco real
│   ├── card.test.ts           # CRUD de cards, versioning, conflicts
│   ├── idempotency.test.ts    # Deduplicação de requisições
│   ├── reconcile.test.ts      # Reconciliação vault → SQLite
│   ├── sprint.test.ts         # Ciclo de vida de sprints
│   └── sse.test.ts            # Broadcast de eventos SSE
└── integration/        # Testes end-to-end via HTTP
    └── http.test.ts           # Fluxos completos: auth, cards, sprints
```

---

## O que é testado / excluído

**Excluídos da cobertura** (configurado em `vitest.config.ts`):
- `src/index.ts` — entry point (side effects de startup)
- `src/server/stdio.ts` — modo stdio (requer processo pai MCP)
- `src/watcher/` — chokidar (filesystem events, não determinístico em CI)
- `src/auth/cli.ts` — CLI interativa

**Coberto:**
- Toda a camada de serviços (`services/`)
- Serialização/deserialização de Markdown
- RBAC (matriz de acesso por tipo de token)
- Schemas JSON de todas as 50 tools
- Operações de banco de dados
- Idempotência e detecção de conflitos
- Fluxos HTTP end-to-end

---

## Como adicionar testes

### Teste de unidade

Para funções puras ou classes sem dependências externas:

```typescript
// packages/server/tests/unit/meu-modulo.test.ts
import { describe, it, expect } from 'vitest'
import { minhaFuncao } from '../../src/util/meu-modulo.js'

describe('minhaFuncao', () => {
  it('deve retornar X quando Y', () => {
    expect(minhaFuncao('input')).toBe('output esperado')
  })
})
```

### Teste de serviço

Para serviços que precisam do banco de dados:

```typescript
// packages/server/tests/service/meu-servico.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDb, teardownTestDb } from '../helpers/db.js'
import { cardFactory } from '../helpers/factories.js'

describe('MeuServico', () => {
  let db: Database

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(async () => {
    await teardownTestDb(db)
  })

  it('deve criar um card', async () => {
    const card = cardFactory({ title: 'Meu card' })
    // ...
  })
})
```

### Teste de integração HTTP

Para testar o fluxo completo via HTTP:

```typescript
// packages/server/tests/integration/meu-fluxo.test.ts
import { createTestClient } from '../helpers/http.js'
import { createTestVault } from '../helpers/vault.js'

describe('Meu fluxo', () => {
  // Veja http.test.ts como referência de setup/teardown
})
```

---

## Convenções

- **Nomeie testes descritivamente:** `deve retornar 409 quando versão está desatualizada`
- **Um assert por cenário** quando possível — facilita identificar o que falhou
- **Use factories** para criar dados de teste, não literais hardcoded
- **Testes não devem depender de ordem** — cada test usa seu próprio banco/vault
- **Não mocke o banco de dados** — use SQLite in-memory real para garantir fidelidade ao comportamento de produção

---

## Testes manuais do web app

A UI não pode ser totalmente testada automaticamente — `jsdom` não renderiza MathJax nem abre `EventSource` de verdade. Execute esta sequência antes de releases ou após mudanças em `packages/web/`.

### Pré-requisitos

- Server rodando com o build do web: `pnpm run build:web && pnpm --filter obsidiankan-mcp run dev`
- Navegador em `http://127.0.0.1:9375` — a sessão é injetada automaticamente pelo `index.html` servido pelo servidor; cole um token de manager só se quiser trocar de identidade

---

### 1. Setup e conectividade

- [ ] Abrir `http://127.0.0.1:9375` — a home carrega sem gate de token (sessão injetada)
- [ ] Verificar que a home lista os projetos existentes
- [ ] Abrir o board de um projeto (`/board/:projeto`) e verificar que carrega sem tela em branco ou erro

### 2. Projeto

- [ ] Clicar em **Novo projeto**
- [ ] Preencher nome e actor, confirmar
- [ ] Verificar que o projeto aparece na lista e o token PM é exibido (uma única vez)
- [ ] Copiar o token PM

### 3. Sprint

- [ ] Com o token PM, criar uma **Nova sprint** (nome e goal)
- [ ] Verificar que a sprint aparece com status `planning`
- [ ] Clicar em **Iniciar sprint**
- [ ] Verificar que o status muda para `active`

### 4. Cards

- [ ] Clicar em **Novo card** no board
- [ ] Preencher título, tipo e prioridade
- [ ] Verificar que o card aparece na coluna `todo`
- [ ] Arrastar o card para `in_progress` (dnd-kit)
- [ ] Verificar que a coluna atualiza corretamente
- [ ] Abrir o card (`/card/:id`) e verificar as três zonas: `Spec` editável, `Notes` colapsável, `Agent Log` como timeline read-only
- [ ] Editar a `Spec` e salvar; verificar que o `Agent Log` permanece intacto

### 5. SSE — atualização em tempo real

- [ ] Deixar o board aberto no navegador
- [ ] Em outro terminal, mover um card via curl:
  ```bash
  curl -s -X POST http://localhost:9375/mcp/tool/kanban_move_card \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    -d '{"id":"<card_id>","status":"done","version":<version>}'
  ```
- [ ] Verificar que o board atualiza **sem reload manual** em até 2 segundos, sem perder scroll/estado de drag
- [ ] Editar o `.md` do card direto no disco e verificar que `CARD_HUMAN_EDITED` chega e o board atualiza

### 6. Conflito de versão

- [ ] Abrir o mesmo card em duas abas
- [ ] Submeter uma atualização pela UI com `version` desatualizada (mudar o card via curl antes de salvar pela UI)
- [ ] Verificar que o **409** aparece como resolução na UI (não como erro cru)

### 7. Rendering

- [ ] Abrir um card com `$$...$$` (MathJax) e bloco ` ```mermaid ` no Agent Log — `card-2vorDD5G` do `test-vault` serve para isso
- [ ] Verificar renderização correta nos dois temas (claro/escuro)

### 8. Atividade e supervisão

- [ ] Abrir `/atividade` e verificar tokens/custo por agente e por projeto
- [ ] Provocar uma escalação (`log_kind: escalate`) e verificar que aparece em `/inbox` e na seção "precisa de você" da home
- [ ] Abrir a aba **History** do card e verificar que reflete `audit.ndjson`

### 9. Token de dev

- [ ] Entrar com um token `dev` e verificar que ações de gestão (criar card, iniciar sprint) não aparecem ou estão desabilitadas
- [ ] Verificar que mover cards e adicionar logs ainda funciona

---

**Critério de aprovação:** todos os itens marcados sem erros no console do navegador (`read_console_messages` ou DevTools). Erros esperados que podem ser ignorados: nenhum.
