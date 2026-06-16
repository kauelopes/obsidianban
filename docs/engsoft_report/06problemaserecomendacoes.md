# 06 — Problemas e Recomendações

Lista priorizada de problemas identificados, do mais crítico ao mais baixo impacto.

---

## CRÍTICO

### 1. Adicionar suíte de testes automatizados

**Problema:** `npm test` falha — o glob `dist/**/*.test.js` não resolve nenhum arquivo. Zero testes existem para lógica crítica (conflict detection, position recalculation, token validation, reconciliation).

**Impacto:** Qualquer refatoração ou nova feature pode introduzir regressões silenciosas. O sistema processa dados financeiramente relevantes (tokens de LLM) e persiste estado em arquivos — bugs de concorrência ou lógica de negócio são difíceis de detectar sem testes.

**Ação:** Ver `05-cobertura-testes.md` para plano detalhado. Começar por `src/cards/serialize.ts` e `src/services/validation.ts` (sem I/O, mais rápidos de testar). Evoluir para `src/services/card.ts` com SQLite `:memory:`.

---

## ALTO

### 2. Corrigir vulnerabilidades de dependência

**Problema:** 3 vulnerabilidades conhecidas (1 HIGH, 2 MODERATE). A vulnerabilidade de `gray-matter` afeta código de produção — qualquer card com merge keys YAML maliciosas pode causar DoS.

**Ação:**
```bash
# Corrige esbuild (sem breaking change)
npm audit fix

# gray-matter: avaliar alternativas antes de fix --force
# Opção A: atualizar js-yaml diretamente como dep explícita
npm install js-yaml@^4.1.2

# Opção B: migrar de gray-matter para @vscode/markdown-it-front-matter
# ou outro parser sem a vulnerabilidade
```

Ver detalhes em `03-dependencias.md`.

### 3. Refatorar `CardService` (god object)

**Problema:** `src/services/card.ts` tem 1393 linhas misturando criação, atualização, movimentação, reordenação, arquivamento, bloqueio, revert, consulta e emissão de SSE.

**Ação sugerida:**

```
src/services/
  card/
    card-writer.ts      # readCardBody(), writeCard() — I/O helpers
    card-position.ts    # PositionService: maxPosition(), recalculate()
    card-create.ts      # createCard()
    card-mutate.ts      # updateCard(), moveCard(), reorderCard()
    card-lifecycle.ts   # archiveCard(), unarchiveCard(), deleteCard()
    card-block.ts       # blockCard(), unblockCard()
    card-revert.ts      # revertField()
    card-query.ts       # getCard(), listCards(), pickNext()
    index.ts            # re-exporta CardService composto
```

Começar extraindo `readCardBody()` (7 ocorrências idênticas) e a constante `POSITION_GAP = 1000` — ambos são mudanças de zero risco.

### 4. Adotar logging estruturado

**Problema:** 35 chamadas `console.*` com prefixos ad-hoc; campo `logLevel` definido em `config.ts` mas nunca usado para filtrar saída.

**Ação:** Adotar `pino` (zero-deps, performance alta, output JSON) ou `winston`. Substituir todas as chamadas de `console.*` por `logger.info()`, `logger.warn()`, `logger.error()` com campos estruturados:

```typescript
// antes
console.log(`[workflow] launched sprint=${sprintId} pid=${child.pid}`)

// depois
logger.info({ sprintId, pid: child.pid }, 'workflow launched')
```

Adicionar `requestId` como campo de contexto em todas as operações MCP para correlação de logs.

---

## MÉDIO

### 5. Padronizar error handling — eliminar `.catch(() => null/[]/'')`

**Problema:** Falhas de I/O são silenciadas em múltiplos pontos (`vault/layout.ts:109,115,118`, `card.ts:747,809,892,939,975`, `repository.ts:277`).

**Ação:** Substituir swallowing silencioso por logging + propagação controlada:

```typescript
// antes
const meta = await loadProjectMeta(paths, project).catch(() => null)

// depois
const meta = await loadProjectMeta(paths, project).catch((err) => {
  logger.warn({ err, project }, 'failed to load project meta')
  return null
})
```

Para os `.catch(() => '')` em leitura de body: avaliar se retornar string vazia é o comportamento correto (pode causar perda de conteúdo em `logOnCard`) ou se deve propagar o erro.

### 6. Adicionar observabilidade ao WorkflowRunner

**Problema:** Processo filho lançado sem `.on('error', ...)` — falha de spawn silenciosa.

**Ação:**

```typescript
child.on('error', (err) => {
  logger.error({ err, sprintId }, 'workflow process failed to start')
})
child.on('exit', (code, signal) => {
  if (code !== 0) logger.warn({ code, signal, sprintId }, 'workflow process exited abnormally')
})
```

No branch sem `logDir`, considerar ao menos redirecionar stderr para o logger do servidor em vez de descartar com `stdio: 'ignore'`.

### 7. Tratar falha de parse SSE no plugin

**Problema:** `plugin/src/mcp/sse-subscriber.ts:125` ignora silenciosamente eventos SSE com payload inválido.

**Ação:** Substituir `/* ignore malformed payload */` por log de debug e, opcionalmente, um contador de métricas. Se o plugin tiver acesso a um logger do Obsidian:

```typescript
} catch (err) {
  console.debug('[sse] malformed event payload', { line, err })
}
```

---

## BAIXO

### 8. Definir constante `POSITION_GAP`

**Problema:** Magic number `1000` hardcoded em 5 lugares.

**Ação:** No topo de `src/services/card.ts`:

```typescript
const POSITION_GAP = 1000
```

Substituir todas as 5 ocorrências. Mudança cirúrgica, zero risco.

### 9. Avaliar split para monorepo

**Problema:** `esbuild` (devDep do plugin) é instalado em qualquer ambiente que rode `npm install`, inclusive servidores de produção.

**Ação (opcional/longo prazo):** Converter para workspaces npm:

```
packages/
  server/          # @obsidiankan/server
  plugin/          # @obsidiankan/plugin
  types/           # @obsidiankan/types (shared)
```

Isso permite que o servidor de produção instale apenas suas deps sem as deps de build do plugin. A decisão depende do custo de manutenção adicional que um monorepo traz.

---

## Sumário Priorizado

| # | Severidade | Problema | Esforço estimado |
|---|-----------|----------|-----------------|
| 1 | CRÍTICO | Zero testes | 2-4 semanas (incremental) |
| 2 | ALTO | Vulnerabilidades npm | 1-2 horas |
| 3 | ALTO | Refatorar CardService | 3-5 dias |
| 4 | ALTO | Logging estruturado | 1-2 dias |
| 5 | MÉDIO | Padronizar error handling | 4-8 horas |
| 6 | MÉDIO | WorkflowRunner error listener | 1 hora |
| 7 | MÉDIO | SSE parse failure logging | 30 minutos |
| 8 | BAIXO | Constante POSITION_GAP | 15 minutos |
| 9 | BAIXO | Split monorepo | 1-2 dias |
