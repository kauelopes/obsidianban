# packages/plugin — @obsidiankan/plugin

Plugin Obsidian para o ObsidianKan. Exibe o board Kanban em tempo real dentro do Obsidian, consumindo o MCP Server via HTTP e SSE.

## Funcionalidades

- **Board view** — visualização Kanban das colunas (backlog, todo, in_progress, review, done)
- **Metrics view** — painel de uso de tokens por agente
- **Card banner** — faixa de ações rápidas ao abrir um arquivo de card
- **SSE** — atualizações em tempo real quando agentes movem cards
- **Modais** — criação de projeto, sprint e tokens direto do Obsidian

## Entry point

`src/main.ts` — estende `Plugin` do obsidian SDK. Registra views, comandos e inicia o SSE subscriber.

## Comandos

```bash
# Build (esbuild → test-vault/.obsidian/plugins/obsidiankan-mcp/)
pnpm build

# Dev mode com watch (recompila ao salvar)
pnpm dev

# Type check
pnpm typecheck
```

### Dev vault customizado

```bash
# Para compilar para um vault específico em vez de test-vault/
export OBSIDIANKAN_DEV_VAULT=/caminho/para/seu/vault
pnpm dev
```

## Estrutura de src/

```
src/
├── main.ts           # Entry point: lifecycle, SSE dispatch, comandos
├── settings.ts       # Interface de configurações (base URL, token)
├── mcp/
│   ├── client.ts     # Cliente HTTP para o MCP Server
│   └── sse-subscriber.ts  # SSE com reconexão exponential backoff
├── ui/
│   ├── create-project-modal.ts
│   ├── create-sprint-modal.ts
│   ├── mint-agent-token-modal.ts
│   └── project-token-modal.ts
├── view/
│   ├── board-view.ts     # Board Kanban (VIEW_TYPE_KANBAN_BOARD)
│   └── metrics-view.ts   # Métricas (VIEW_TYPE_KANBAN_METRICS)
└── editor/
    └── card-banner.ts    # Banner inline nos arquivos de card
```

## Configuração no Obsidian

Após instalar, configure em **Configurações → Plugins → ObsidianKan**:

| Campo | Padrão | Descrição |
|---|---|---|
| URL base | `http://127.0.0.1:9375` | Endereço do MCP Server |
| Token | — | Bearer token (pm ou dev) para autenticação |

## Instalação manual (sem store)

```bash
# Compilar
pnpm build

# Copiar para o vault
cp -r test-vault/.obsidian/plugins/obsidiankan-mcp/ \
      /caminho/para/vault/.obsidian/plugins/

# Ativar no Obsidian
# Configurações → Plugins da comunidade → Modo restrito desativado → Ativar ObsidianKan
```

## Dependência do shared

O plugin importa tipos de `@obsidiankan/types` (packages/shared). Se alterar tipos compartilhados, recompile o shared antes:

```bash
pnpm --filter @obsidiankan/types build
pnpm build
```
