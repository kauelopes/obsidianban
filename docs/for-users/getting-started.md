# Primeiros Passos — ObsidianKan

Guia de instalação e configuração do zero até o servidor rodando.

---

## Pré-requisitos

| Requisito | Versão mínima | Verificar |
|---|---|---|
| Node.js | 22+ | `node --version` |
| pnpm | qualquer | `~/.local/share/pnpm/bin/pnpm --version` |
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

## 2. Compilar o servidor e o web app

```bash
~/.local/share/pnpm/bin/pnpm run build       # packages/shared → packages/server
~/.local/share/pnpm/bin/pnpm run build:web   # packages/web/dist — servido pelo servidor
```

O servidor decide se serve o SPA **uma única vez, no boot** — se `packages/web/dist` não existir quando ele subir, roda só como API até ser reiniciado. Por isso o build do web app vem antes do próximo passo, não depois.

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

# Ou via script npm — não carrega .env sozinho, exporte as variáveis antes:
export VAULT_PATH=/caminho/para/vault
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run start
```

O servidor inicia na porta `9375` (ou a de `MCP_HTTP_PORT`) e você deve ver no log:

```
{"level":"info","port":9375,"msg":"startup: http listening"}
```

---

## 5. Verificar que está funcionando

```bash
# Health check
curl http://127.0.0.1:9375/health
# → {"status":"ok"}
```

Abra `http://127.0.0.1:9375` no navegador para o board web. **Não pede token**: em loopback (`127.0.0.1`/`localhost`), o servidor injeta uma sessão de manager efêmera — em memória, gerada de novo a cada boot — direto no `index.html`. Basta criar um projeto pela UI (`+ projeto`) e já está no ar. Um token só é necessário para os casos abaixo.

---

## 6. Tokens para CLI e agentes (opcional)

A sessão automática do passo anterior só vale para o navegador em loopback. Para usar o Claude CLI, agentes MCP, ou acessar de fora da máquina, gere um **manager token** de verdade pela CLI, com o `VAULT_PATH` já no ambiente:

```bash
VAULT_PATH=/caminho/para/vault node packages/server/dist/auth/cli.js create --role manager --actor "human:seu-nome"
# → token: ... — guarde agora, não é recuperável
```

Com o manager token em mãos, use o Claude CLI para criar projetos e mintar tokens de pm/dev:

```bash
# Com Claude CLI e manager token configurado (ex. export KANBAN_TOKEN=...):
claude
# Carregue a skill: /kanban-manager-agent
# Siga o guia do runbook: docs/for-agents/agent-runbook.md
```

Colar esse token no gate do web app também funciona — substitui a sessão automática pela do token colado, útil para acessar de fora do loopback ou depois que o servidor reiniciar.

---

## Próximos passos

- [Guia de agentes](../for-agents/agent-runbook.md) — criar tokens, configurar PM e Dev
- [Catálogo de tools](../for-agents/tool-catalog.md) — todas as 50 ferramentas MCP
- [Troubleshooting](troubleshoot.md) — erros comuns e soluções
- [Configuração de referência](../reference/config.md) — todas as variáveis de ambiente
