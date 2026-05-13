# Sprint 01 — Foundation

**Objetivo:** Estabelecer toda a infraestrutura base do sistema: estrutura de vault, persistência atômica (.md + SQLite), file watcher com proteção de invariantes, reconciliação de startup e scaffold do servidor MCP com autenticação.

**Critério de encerramento:** o servidor MCP inicia, autentica tokens, o file watcher detecta e reverte edições inválidas, o SQLite é reconstruído do zero a partir dos `.md` sem perda de dados, e o servidor sobe via `./container.sh start` com `/health` respondendo 200.

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
| TASK-08b | Implementar endpoint `GET /health` | `implementation` |
| TASK-08c | Criar `Dockerfile` e `.dockerignore` | `scaffold` |
| TASK-08d | Criar `container.sh` e `.env.example` para Podman 3.4.4 | `scaffold` |

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
- Schema criado em `db.sqlite` no primeiro startup com tabelas `cards` e `token_log`
- Todos os índices presentes e verificáveis via `PRAGMA index_list`
- Startup seguro: se schema já existe, não recriar destrutivamente
- Colunas `type`, `total_input_tokens` e `total_output_tokens` presentes em `cards` com defaults corretos

**Testes:**
- Startup com DB inexistente → ambas as tabelas criadas corretamente
- Startup com DB existente → nenhuma alteração destrutiva
- Verificar índices com `PRAGMA index_list('cards')` — incluindo `idx_project_type`
- Verificar índices de `token_log` com `PRAGMA index_list('token_log')`
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
CLI para gerenciar os dois tipos de token do sistema. Apenas o SHA-256 do token é armazenado — nunca o raw. Os dois tipos têm estrutura e escopo distintos (§3.2):

**Agent token** — project-scoped. Armazenado em `_meta.json` do projeto.
```bash
kanban-token create --project projeto-x --role agent --actor agent:codex-1
kanban-token revoke --project projeto-x --token-id <id>
kanban-token list --project projeto-x
```

**Manager token** — project-unscoped. Armazenado em `.kanban/manager-tokens.json` (vault-level, não por projeto).
```bash
kanban-token create --role manager --actor human:manager
kanban-token revoke --manager --token-id <id>
kanban-token list --manager
```

**Definition of Done:**
- Agent tokens: apenas SHA-256 em `_meta.json`, vinculados a exatamente um `project_id`
- Manager tokens: apenas SHA-256 em `.kanban/manager-tokens.json`, sem `project_id`
- Token revogado tem efeito na próxima chamada MCP (BR-05)
- `list` exibe apenas metadados (`token-id`, `actor`, `created_at`, `role`), nunca o token raw
- Manager tokens nunca aparecem em `kanban-token list --project`

**Testes:**
- Criar agent token → usar em chamada MCP para o projeto correto → autenticado
- Usar agent token para projeto diferente → 404 (BR-03)
- Criar manager token → usar em chamada MCP para qualquer projeto → autenticado com `role=manager`
- Revogar agent token → chamada MCP seguinte → 401
- Listar tokens → sem token raw na saída

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
- Computar SHA-256 → buscar em `_meta.json` (agent) ou `.kanban/manager-tokens.json` (manager)
- Token inválido ou revogado → 401
- Extrair `role` e `project_id` do registro do token → montar `TokenClaims` (§3.2, design/interfaces.ts)
- Agent: disponibilizar `project_id` no contexto imutável (BR-02); manager: sem filtro de projeto

**Definition of Done:**
- Servidor inicia em stdio e HTTP na mesma instância
- Toda chamada sem token válido retorna 401
- `project_id` do agent token não pode ser sobrescrito pelo payload (BR-02)
- Manager token: `TokenClaims.role === 'manager'`, sem restrição de projeto
- Contexto de request carrega `TokenClaims` tipado conforme `docs/design/interfaces.ts`
- Estrutura pronta para receber implementação das tools (Sprint 02)

**Testes:**
- Chamada sem token → 401
- Agent token de projeto X acessando card do projeto Y → 404 (BR-03)
- Manager token acessando card de qualquer projeto → autenticado com `role=manager`
- Chamada com token válido → passa pelo middleware sem erro, `TokenClaims` disponível no contexto

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

---

### TASK-08b: Implementar endpoint `GET /health`

**Tipo:** `implementation`

**Descrição:**
Endpoint sem autenticação para health check da instância MCP. Usado pelo container HEALTHCHECK e pelo plugin Obsidian para detecção de MCP offline.

```
GET /health
→ 200 { "status": "ok", "uptime_s": N, "vault": "/vault", "cards_indexed": N }
→ 503 durante reconciliação de startup (SQLite ainda não disponível)
```

Bound a `127.0.0.1` apenas — nunca exposto externamente.

**Definition of Done:**
- Retorna 200 com payload JSON correto após startup completo
- Retorna 503 enquanto reconciliação ainda não concluiu
- `cards_indexed` reflete o count atual do SQLite
- Nenhum token requerido na chamada

**Testes:**
- `curl http://localhost:3000/health` após startup → 200 com `status: ok`
- Chamar durante reconciliação → 503
- Confirmar que plugin usa este endpoint para detecção de offline (§11.4)

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-08c: Criar `Dockerfile` e `.dockerignore`

**Tipo:** `scaffold`

**Descrição:**
Dockerfile single-stage baseado em `node:22-slim` (Debian 12 glibc). `better-sqlite3` distribui binários pré-compilados para linux/x64 glibc — nenhuma ferramenta de build necessária (`python3`, `make`, `g++`).

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/index.js"]
```

`USER node` usa uid 1000, compatível com `--userns=keep-id` do Podman rootless.

`.dockerignore` exclui: `node_modules/`, `.env`, `.env.*` (exceto `.env.example`), `docs/`, arquivos de teste, artefatos de SO.

**Definition of Done:**
- `./container.sh build` conclui sem erros
- Imagem final ≤ 130 MB
- `better-sqlite3` funciona sem etapa de compilação nativa
- `USER node` (uid 1000) configurado para compatibilidade com Podman rootless

**Testes:**
- `./container.sh build` → sem erros, imagem criada
- `podman image ls obsidiankan-mcp` → size ≤ 130 MB
- `./container.sh start && curl http://localhost:3000/health` → 200 ok

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-08d: Criar `container.sh` e `.env.example` para Podman 3.4.4

**Tipo:** `scaffold`

**Descrição:**
Script POSIX sh (`container.sh`) que encapsula todos os comandos `podman run` necessários para operar o MCP server. Podman compose não é usado (requer 4.7+; versão em uso é 3.4.4).

**Comandos suportados:**
```
./container.sh build      # podman build -t obsidiankan-mcp:latest .
./container.sh start      # podman run -d com todas as flags necessárias
./container.sh stop       # podman stop + podman rm
./container.sh restart    # stop → start
./container.sh logs       # podman logs -f
./container.sh status     # podman inspect (state, pid, started)
./container.sh exec ...   # podman exec -it (ex: node src/index.js --stdio)
```

**Flags obrigatórias no `podman run`:**
- `--userns=keep-id` — mapeia UID do host para uid 1000 (node) dentro do container
- `-v "${VAULT_PATH}:/vault:z"` — `:z` relabela para SELinux (Fedora/RHEL)
- `-p "127.0.0.1:${MCP_HTTP_PORT}:3000"` — bound ao loopback apenas
- `--restart unless-stopped`

**`.env.example`:**
```
VAULT_PATH=/home/youruser/Documents/MyVault
MCP_HTTP_PORT=3000
LOG_LEVEL=info
```

O script carrega `.env` automaticamente se presente. `VAULT_PATH` é obrigatório — erro explícito se não definido.

**Definition of Done:**
- `./container.sh start` inicia o container com as flags corretas
- `./container.sh exec node src/index.js --stdio` funciona para agentes stdio
- `.env` carregado automaticamente — sem necessidade de exportar variáveis manualmente
- `VAULT_PATH` não definido → erro claro antes de tentar subir o container

**Testes:**
- `./container.sh build && ./container.sh start` → container rodando
- `./container.sh status` → exibe estado, pid e timestamp de start
- `./container.sh stop` → container removido, dados no vault preservados no host
- Sem `.env` e sem `VAULT_PATH` exportado → mensagem de erro legível

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:
