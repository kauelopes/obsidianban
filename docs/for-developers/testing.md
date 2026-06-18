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
- Schemas JSON de todas as 27 tools
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

## Testes manuais do plugin Obsidian

A UI do plugin não pode ser testada automaticamente (depende do runtime do Obsidian). Execute esta sequência antes de releases ou após mudanças no `packages/plugin/`.

### Pré-requisitos

- Server rodando: `pnpm --filter obsidiankan-mcp run dev`
- Plugin instalado no vault de teste: `pnpm --filter @obsidiankan/plugin run build`
- Token de manager configurado nas configurações do plugin (`Configurações → Plugins → ObsidianKan`)

---

### 1. Setup e conectividade

- [ ] Abrir o Obsidian com o vault de teste
- [ ] Verificar que o plugin não exibe erro de conexão no canto inferior direito
- [ ] Abrir a **Board View** (`Ctrl+P` → "ObsidianKan: Abrir Board")
- [ ] Verificar que o board carrega sem tela em branco ou erro

### 2. Projeto

- [ ] Clicar em **Novo projeto** no board
- [ ] Preencher nome e actor, confirmar
- [ ] Verificar que o projeto aparece na lista e o token PM é exibido
- [ ] Copiar o token PM e configurá-lo nas configurações do plugin

### 3. Sprint

- [ ] Com o token PM ativo, clicar em **Nova sprint**
- [ ] Preencher nome e goal, confirmar
- [ ] Verificar que a sprint aparece no board com status `planning`
- [ ] Clicar em **Iniciar sprint**
- [ ] Verificar que o status muda para `active`

### 4. Cards

- [ ] Clicar em **Novo card** no board
- [ ] Preencher título, tipo e prioridade
- [ ] Verificar que o card aparece na coluna `todo`
- [ ] Arrastar (ou usar menu) para mover o card para `in_progress`
- [ ] Verificar que a coluna atualiza corretamente
- [ ] Abrir o arquivo `.md` do card no vault
- [ ] Verificar que o **card banner** aparece no topo do arquivo com as ações (mover, log, etc.)
- [ ] Usar o banner para mover o card para `review`
- [ ] Verificar que o board reflete a mudança

### 5. SSE — atualização em tempo real

- [ ] Deixar o board visível no Obsidian
- [ ] Em outro terminal, mover um card via curl:
  ```bash
  curl -s -X POST http://localhost:9375/mcp/tool/kanban_move_card \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    -d '{"id":"<card_id>","status":"done","version":<version>}'
  ```
- [ ] Verificar que o board atualiza **sem reload manual** em até 2 segundos
- [ ] Verificar o indicador de status SSE (ícone de conexão no board)

### 6. Conflict modal

- [ ] Abrir o mesmo card via API e via plugin simultaneamente
- [ ] Submeter uma atualização via plugin com versão desatualizada (editar diretamente o `.md` do card antes de salvar pelo plugin)
- [ ] Verificar que o **conflict modal** aparece com os campos em conflito
- [ ] Escolher "usar versão do servidor" e verificar que o card atualiza

### 7. Métricas

- [ ] Abrir a **Metrics View** (`Ctrl+P` → "ObsidianKan: Abrir Métricas")
- [ ] Verificar que os dados de tokens por agente aparecem
- [ ] Verificar que os filtros de data funcionam (se disponíveis)

### 8. Reconexão SSE

- [ ] Com o board aberto, derrubar o server (`Ctrl+C` no terminal)
- [ ] Verificar que o indicador de status muda para `disconnected`
- [ ] Reiniciar o server
- [ ] Verificar que o plugin reconecta automaticamente (sem reiniciar o Obsidian)
- [ ] Mover um card via curl e verificar que o board volta a atualizar em tempo real

### 9. Token de dev

- [ ] Em **Configurações → Plugins → ObsidianKan**, trocar para um token `dev`
- [ ] Abrir o board e verificar que as ações de gestão (criar card, iniciar sprint) não aparecem ou estão desabilitadas
- [ ] Verificar que mover cards e adicionar logs ainda funciona

---

**Critério de aprovação:** todos os itens marcados sem erros no console do Obsidian (`Ctrl+Shift+I → Console`). Erros esperados que podem ser ignorados: nenhum.
