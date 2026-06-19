# Primeiros Passos — ObsidianKan

Guia de instalação e configuração do zero até o servidor rodando.

---

## Pré-requisitos

| Requisito | Versão mínima | Verificar |
|---|---|---|
| Node.js | 22+ | `node --version` |
| pnpm | qualquer | `~/.local/share/pnpm/bin/pnpm --version` |
| Obsidian | 1.12+ | (para o plugin) |
| Vault Obsidian | — | pasta existente no filesystem |

> **pnpm não encontrado?** Instale com: `curl -fsSL https://get.pnpm.io/install.sh | sh -`

---

## 1. Clonar e instalar dependências

```bash
git clone <repo-url> obsidiankan
cd obsidiankan

# Instalar todas as dependências do monorepo
~/.local/share/pnpm/bin/pnpm install
```

---

## 2. Compilar o servidor

```bash
~/.local/share/pnpm/bin/pnpm run build
```

Isso compila `packages/shared` e `packages/server` (nessa ordem, via TypeScript project references). O output fica em `packages/server/dist/`.

---

## 3. Configurar variáveis de ambiente

Copie o arquivo de exemplo e edite:

```bash
cp .env.example .env
```

Edite `.env` com os valores do seu ambiente:

```bash
# Obrigatório: caminho absoluto para o seu vault Obsidian
VAULT_PATH=/home/seu-usuario/Documents/MeuVault

# Porta HTTP (padrão 9375)
MCP_HTTP_PORT=9375

# Nível de log
LOG_LEVEL=info
```

Veja a referência completa de configuração em [`docs/reference/config.md`](../reference/config.md).

---

## 4. Executar o servidor

```bash
VAULT_PATH=/caminho/para/vault node packages/server/dist/index.js

# Ou via script npm (carrega .env automaticamente se usar dotenv)
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run start
```

O servidor inicia na porta `9375` e você deve ver no log:

```
{"level":"info","msg":"ObsidianKan MCP Server","port":9375}
```

---

## 5. Verificar que está funcionando

```bash
# Health check
curl http://127.0.0.1:9375/health
# → {"status":"ok"}
```

---

## 6. Criar um projeto e tokens (primeiro uso)

Use o Claude CLI com um **manager token** (gerado no primeiro boot — veja os logs do servidor) para criar um projeto:

```bash
# O servidor imprime o manager token inicial nos logs de startup
# Guarde-o e use como KANBAN_TOKEN

# Com Claude CLI e manager token configurado:
claude
# Carregue a skill: /kanban-manager-agent
# Siga o guia do runbook: docs/for-agents/agent-runbook.md
```

---

## 7. Instalar o Plugin Obsidian (opcional)

O plugin permite visualizar o board diretamente no Obsidian.

```bash
# Compilar o plugin
~/.local/share/pnpm/bin/pnpm run build:plugin
```

O plugin é compilado para `packages/plugin/test-vault/.obsidian/plugins/obsidiankan-mcp/`.

Para instalar no seu vault:
1. Copie a pasta `obsidiankan-mcp/` para `<seu-vault>/.obsidian/plugins/`
2. Abra Obsidian → Configurações → Plugins da comunidade → Ativar "ObsidianKan"
3. Configure: URL base `http://127.0.0.1:9375` e seu token de agente

---

## Próximos passos

- [Guia de agentes](../for-agents/agent-runbook.md) — criar tokens, configurar PM e Dev
- [Catálogo de tools](../for-agents/tool-catalog.md) — todas as 27 ferramentas MCP
- [Troubleshooting](troubleshoot.md) — erros comuns e soluções
- [Configuração de referência](../reference/config.md) — todas as variáveis de ambiente
