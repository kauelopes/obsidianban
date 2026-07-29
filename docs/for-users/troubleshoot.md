# Troubleshooting — ObsidianKan

Soluções para os problemas mais comuns.

---

## Servidor não inicia

### `Error: VAULT_PATH is required`

**Causa:** A variável de ambiente obrigatória não está definida.

```bash
# Solução: defina antes de iniciar
VAULT_PATH=/caminho/para/vault node packages/server/dist/index.js

# Ou adicione ao .env e carregue com dotenv
```

---

### `Error: listen EADDRINUSE :::9375`

**Causa:** A porta já está em uso por outra instância.

```bash
# Descobrir o processo na porta
lsof -i :9375

# Matar o processo ou usar outra porta
MCP_HTTP_PORT=9376 node packages/server/dist/index.js
```

---

### `better-sqlite3` falha ao carregar

**Causa:** O módulo nativo não foi compilado para a versão atual do Node.js.

```bash
# Recompilar
~/.local/share/pnpm/bin/pnpm install --force
~/.local/share/pnpm/bin/pnpm run build
```

---

## Erros de autenticação

### `401 Unauthorized`

**Causa:** Token ausente ou inválido no header `Authorization`.

```bash
# Verificar se o token está correto
curl -H "Authorization: Bearer SEU_TOKEN" http://127.0.0.1:9375/health
```

**Soluções:**
- Confirme que o token foi gerado via `kanban_create_agent_token`
- Tokens são prefixados por tipo: `mgr-...`, `pm-...`, `dev-...`
- O manager token inicial é impresso nos logs de startup do servidor

---

### `403 Forbidden`

**Causa:** O tipo do token não tem permissão para a tool chamada.

- `dev` tokens não podem: `create_card`, `create_sprint`, `create_project`
- `pm` tokens não podem: `create_project`, `create_agent_token`, `delete_project`
- Veja a matriz completa em [`docs/for-agents/tool-catalog.md`](../for-agents/tool-catalog.md)

---

## SSE / Board web

### Board não atualiza em tempo real

**Causa:** A conexão SSE foi perdida.

**Verificar:**
```bash
# Checar se o endpoint SSE responde
curl -N -H "Authorization: Bearer SEU_TOKEN" http://127.0.0.1:9375/events
# Deve manter conexão aberta e receber eventos
```

**Soluções:**
- O navegador reconecta automaticamente (`EventSource` nativo, com `Last-Event-ID`)
- Recarregar a página força uma nova conexão

---

## Problemas com SQLite

### `database disk image is malformed`

**Causa:** Corrupção do arquivo SQLite (crash durante escrita).

```bash
# O SQLite é um índice derivado — pode ser reconstruído
# Simplesmente delete e reinicie o servidor
rm <seu-vault>/.kanban/db.sqlite

# O servidor reconstrói automaticamente a partir dos .md no startup
```

---

### Cards do vault não aparecem

**Causa:** Sincronização entre .md e SQLite desatualizada.

**Solução:** Reiniciar o servidor força a reconciliação completa:
```bash
# O startup sempre reconcilia vault → SQLite
```

---

## Como ler os logs

O servidor usa [pino](https://getpino.io/) para logs estruturados em JSON.

```bash
# Logs legíveis com pino-pretty (instalar se necessário)
node packages/server/dist/index.js | npx pino-pretty

# Aumentar verbosidade
LOG_LEVEL=debug node packages/server/dist/index.js
```

**Níveis de log:**
- `debug` — detalhes de cada operação (verbose)
- `info` — operações normais (padrão)
- `warn` — situações inesperadas mas não fatais
- `error` — erros com stack trace

---

## Workflow autônomo não inicia

### Sprint inicia mas nenhum agente é spawned

**Causa:** `WORKFLOW_ENABLED` não está definido ou é `false`.

```bash
# Verificar no .env
WORKFLOW_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-...
KANBAN_PM_TOKEN=pm-...
KANBAN_DEV_TOKEN=dev-...
```

### Workflow inicia mas falha imediatamente

```bash
# Ver logs do workflow
tail -f <WORKFLOW_LOG_DIR>/sprint-*.log

# Verificar se claude CLI está no PATH
which claude
```

---

## Ainda com problemas?

1. Aumente o log level para `debug`
2. Verifique o audit log: `<seu-vault>/.kanban/audit.ndjson`
3. Inspecione o SQLite diretamente:
   ```bash
   sqlite3 <seu-vault>/.kanban/db.sqlite ".tables"
   sqlite3 <seu-vault>/.kanban/db.sqlite "SELECT * FROM cards LIMIT 5;"
   ```
