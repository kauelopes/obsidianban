# Sprint 01 — Foundation

**Objetivo:** Estabelecer toda a infraestrutura base do sistema: estrutura de vault, persistência atômica (.md + SQLite), file watcher com proteção de invariantes, reconciliação de startup e scaffold do servidor MCP com autenticação.

**Critério de encerramento:** o servidor MCP inicia, autentica tokens, o file watcher detecta e reverte edições inválidas, e o SQLite é reconstruído do zero a partir dos `.md` sem perda de dados.

---

## Tasks

| ID | Título | Tipo |
|---|---|---|
| TASK-01 | Criar estrutura de diretórios do vault | `scaffold` |
| TASK-02 | Definir e criar o schema SQLite | `scaffold` |
| TASK-03 | Implementar o atomic writer (.md + SQLite na mesma operação) | `implementation` |
| TASK-04 | Implementar o file watcher com debounce e revert de campos imutáveis | `implementation` |
| TASK-05 | Implementar reconciliação na inicialização (hash-based) | `implementation` |
| TASK-06 | Implementar CLI de provisionamento de tokens | `implementation` |
| TASK-07 | Criar scaffold do servidor MCP com auth middleware | `scaffold` |
| TASK-08 | Implementar idempotency store | `implementation` |

---

## Task Details

### TASK-01: Criar estrutura de diretórios do vault

**Tipo:** `scaffold`

**Descrição:**
Criar e validar a estrutura de pastas esperada pelo sistema dentro do vault Obsidian. Os diretórios com prefixo `.` ficam ocultos do explorador de arquivos do Obsidian por padrão.

```
vault/
  .kanban-data/          ← cards por projeto (oculto do Obsidian)
    {projeto}/
      _meta.json         ← metadata do projeto, token hashes, colunas
      card-{id}.md
  .kanban/               ← dados internos do MCP (oculto)
    db.sqlite
    audit.ndjson
    idempotency.json
```

**Definition of Done:**
- Diretórios criados programaticamente se não existirem no startup
- `_meta.json` gerado com estrutura mínima válida (`columns`, `project_id`)
- Estrutura reproduzível via script de setup

**Testes:**
- Deletar `.kanban/` e `.kanban-data/` → reiniciar MCP → ambas as pastas recriadas corretamente
- Confirmar que `.kanban-data/` não aparece no explorador do Obsidian

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-02: Definir e criar o schema SQLite

**Tipo:** `scaffold`

**Descrição:**
Criar o schema `cards` conforme §5.3 do PRD, com todos os campos de frontmatter necessários para queries e renderização do board. O body do card **não** é armazenado no SQLite.

```sql
CREATE TABLE cards (
  id                   TEXT PRIMARY KEY,
  project              TEXT NOT NULL,
  title                TEXT NOT NULL,
  status               TEXT NOT NULL,
  type                 TEXT NOT NULL,
  version              INTEGER NOT NULL,
  position             INTEGER NOT NULL,
  priority             TEXT NOT NULL DEFAULT 'medium',
  tags                 TEXT NOT NULL DEFAULT '[]',  -- JSON array
  due_date             TEXT,
  assigned_to          TEXT,
  owner                TEXT,
  agent_notes          TEXT,
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  updated_by           TEXT NOT NULL,
  file_hash            TEXT NOT NULL  -- SHA-256 do .md file
);

CREATE INDEX idx_project_status   ON cards(project, status);
CREATE INDEX idx_project_position ON cards(project, status, position);
CREATE INDEX idx_project_type     ON cards(project, type);
CREATE INDEX idx_due_date         ON cards(due_date);
CREATE INDEX idx_assigned_to      ON cards(assigned_to);
```

**Definition of Done:**
- Schema criado em `db.sqlite` no primeiro startup
- Todos os índices presentes e verificáveis via `PRAGMA index_list`
- Startup seguro: se schema já existe, não recriar destrutivamente
- Colunas `type`, `total_input_tokens` e `total_output_tokens` presentes com defaults corretos

**Testes:**
- Startup com DB inexistente → schema criado corretamente
- Startup com DB existente → nenhuma alteração destrutiva
- Verificar índices com `PRAGMA index_list('cards')` — incluindo `idx_project_type`
- Inserir card sem `total_input_tokens` → valor default `0` aplicado automaticamente

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-03: Implementar o atomic writer (.md + SQLite na mesma operação)

**Tipo:** `implementation`

**Descrição:**
Toda escrita de card deve ser atômica: arquivo `.md` e SQLite atualizados juntos, sem janela de inconsistência. O padrão `.tmp → rename` garante atomicidade no filesystem POSIX.

**Sequência obrigatória:**
1. Setar flag `MCP-originated` para o `card_id` (evita double-processing pelo watcher)
2. Computar conteúdo atualizado em memória
3. Escrever em `.kanban-data/{project}/{id}.md.tmp`
4. `fsync` no `.tmp`
5. `rename .tmp → .md` (atômico no POSIX)
6. Atualizar SQLite em transação
7. Limpar flag `MCP-originated`
8. Appender entrada no audit log

**Definition of Done:**
- Kill -9 durante a escrita não produz `.md` corrompido (apenas `.tmp` no pior caso)
- Startup limpa arquivos `.tmp` órfãos antes de aceitar conexões
- `file_hash` em SQLite sempre bate com SHA-256 do `.md` após escrita
- `total_input_tokens` e `total_output_tokens` acumulados corretamente no frontmatter e no SQLite a cada escrita mutante

**Testes:**
- Simular kill durante step 3 → apenas `.tmp` presente → startup limpa e o sistema segue consistente
- Simular kill durante step 5 → `.md` válido presente (rename já aconteceu)
- Após qualquer escrita bem-sucedida: SHA-256 do `.md` == `file_hash` no SQLite
- Executar 3 operações mutantes no mesmo card com tokens distintos → `total_input_tokens` no frontmatter = soma dos três `input_tokens` reportados

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-04: Implementar o file watcher com debounce e revert de campos imutáveis

**Tipo:** `implementation`

**Descrição:**
O file watcher (chokidar) monitora `vault/.kanban-data/**/*.md` e é a camada de enforcement para edições humanas diretas. Processa cada evento segundo o pipeline abaixo.

**Pipeline de processamento:**
```
Evento detectado
│
├─ Flag MCP-originated ativo? → SIM → skip
│
└─ NÃO (edição humana ou sync externo)
   │
   ├─ Parse frontmatter YAML
   │   └─ FALHA → revert arquivo inteiro → log PARSE_ERROR
   │
   ├─ Comparar campos imutáveis vs SQLite
   │   (id, project, version, position, created_at, created_by)
   │   └─ ALTERADO → revert esses campos → log FIELD_REVERTED por campo
   │
   ├─ Validar campos mutáveis (status em columns, due_date formato, etc.)
   │   └─ INVÁLIDO → revert apenas o campo inválido → log FIELD_REVERTED
   │
   ├─ Incrementar version, setar updated_at, updated_by='human:manager'
   ├─ Escrever arquivo corrigido atomicamente
   ├─ Atualizar SQLite
   └─ Log HUMAN_EDIT
```

**Debounce:** 500ms por arquivo após o último evento antes de processar.

**Definition of Done:**
- Edição de campo imutável revertida em até 600ms; campos editáveis do mesmo save preservados
- Frontmatter corrompido revertido em até 600ms; log `PARSE_ERROR`
- Status inválido revertido; body e demais campos preservados
- Edições rápidas sucessivas produzem apenas 1 incremento de versão
- Flag `MCP-originated` impede que o watcher reprocesse writes do próprio MCP

**Testes:**
- Editar `id` no frontmatter → aguardar 600ms → `id` revertido, body preservado, `FIELD_REVERTED` no log
- Deletar `---` separator → aguardar 600ms → arquivo revertido, `PARSE_ERROR` no log
- Setar `status: coluna-inexistente` → aguardar 600ms → status revertido, title e body preservados
- Salvar 10x em 1s → apenas 1 incremento de versão no SQLite

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-05: Implementar reconciliação na inicialização (hash-based)

**Tipo:** `implementation`

**Descrição:**
No startup, o MCP compara o SHA-256 de cada `.md` com o `file_hash` armazenado em SQLite. Detecta e corrige divergências que ocorreram enquanto o MCP estava offline.

**Sequência de startup:**
1. Abrir SQLite (criar schema se não existir)
2. Limpar `.tmp` órfãos
3. Scan de todos os `.md` em `.kanban-data/`
4. Para cada arquivo: computar SHA-256 → comparar com `file_hash`
   - Igual → skip
   - Diferente ou ausente → re-parsear, validar, atualizar SQLite → log `RECONCILED`
5. Entrada no SQLite sem `.md` correspondente → deletar → log `ORPHAN_REMOVED`
6. Se SQLite foi criado do zero → log `SQLITE_REBUILT`
7. Iniciar aceitar conexões

**Definition of Done:**
- SQLite deletado → startup reconstrói tudo dos `.md` → todos os cards queryáveis
- Cards editados offline aparecem com estado correto após startup
- Orphan entries no SQLite removidas com log

**Testes:**
- Deletar `db.sqlite` → reiniciar → todos os cards presentes e corretos, log `SQLITE_REBUILT`
- Editar `.md` com MCP offline → reiniciar → card reflete edição, log `RECONCILED`
- Remover `.md` manualmente → startup remove orphan do SQLite, log `ORPHAN_REMOVED`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-06: Implementar CLI de provisionamento de tokens

**Tipo:** `implementation`

**Descrição:**
CLI para gerenciar tokens de acesso de agentes. Apenas o SHA-256 do token é armazenado no `_meta.json` — nunca o token raw. Cada token é vinculado a exatamente um `project_id`.

**Comandos:**
```bash
kanban-token create --project projeto-x --actor agent:codex-1
kanban-token revoke --project projeto-x --token-id <id>
kanban-token list --project projeto-x
```

**Definition of Done:**
- Apenas SHA-256 armazenado em `_meta.json`
- Token revogado tem efeito na próxima chamada MCP (BR-05)
- `list` exibe apenas metadados (`token-id`, `actor`, `created_at`), nunca o token raw
- Manager token é project-unscoped e gerado separadamente

**Testes:**
- Criar token → usar em chamada MCP → autenticado com sucesso
- Revogar token → chamada MCP seguinte → 401
- Listar tokens → saída não contém o token raw

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-07: Criar scaffold do servidor MCP com auth middleware

**Tipo:** `scaffold`

**Descrição:**
Servidor MCP em Node.js expondo dois transports: `stdio` (agentes locais) e `HTTP+SSE` (agentes remotos e plugin). Auth middleware valida token a cada chamada de tool mutante.

**Responsabilidades do middleware:**
- Extrair token do header `Authorization: Bearer <token>`
- Computar SHA-256 → comparar com `_meta.json` do projeto
- Token inválido ou revogado → 401
- Extrair `project_id` do token → disponibilizar no contexto da request (imutável — BR-02)

**Definition of Done:**
- Servidor inicia em stdio e HTTP na mesma instância
- Toda chamada sem token válido retorna 401
- `project_id` do token não pode ser sobrescrito pelo payload de nenhuma request
- Estrutura pronta para receber implementação das tools (Sprint 02)

**Testes:**
- Chamada sem token → 401
- Chamada com token de projeto X acessando card do projeto Y → 404 (não 403, BR-03)
- Chamada com token válido → passa pelo middleware sem erro

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-08: Implementar idempotency store

**Tipo:** `implementation`

**Descrição:**
Todas as tools mutantes aceitam `request_id` (UUID v4). Se o mesmo `request_id` for recebido dentro de 24h, retorna a resposta cacheada sem re-executar. Store persistido em `.kanban/idempotency.json` para sobreviver a restarts.

**Regras:**
- `request_id` não-UUID v4 → rejeitar com 400 `invalid_request_id`
- `request_id` já visto nas últimas 24h → retornar resposta cacheada sem side effects
- Entradas com mais de 24h removidas no startup (cleanup)

**Definition of Done:**
- Retry com mesmo `request_id` → resposta idêntica, nenhum efeito colateral adicional
- Store persiste entre restarts do MCP
- `request_id` inválido retorna 400 antes de qualquer lógica de negócio

**Testes:**
- Criar card com `request_id` → retry → apenas 1 arquivo `.md` criado, respostas idênticas
- Restart do MCP → retry com mesmo `request_id` → ainda retorna resposta cacheada
- `request_id` com formato inválido → 400 `invalid_request_id`
- Entry com > 24h → removida no próximo startup

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:
