# PRD — ObsidianKan: Melhorias de Qualidade

> Originado da análise de engenharia de software em `docs/engsoft_report/` (score: 5.5/10).  
> Atualize o cabeçalho abaixo conforme cada item for concluído.

---

## Status de Progresso

| # | Item | Prioridade | Esforço est. | Status |
|---|------|-----------|-------------|--------|
| 1 | Suite de testes automatizados (vitest, todas as fases) | CRÍTICO | 2–4 semanas | ✅ Concluído |
| 2 | Corrigir vulnerabilidades de dependência | HIGH | 1–2 horas | ⬜ Pendente |
| 3 | Refactor CardService — extração incremental | HIGH | 3–5 dias | ⬜ Pendente |
| 4 | Logging estruturado com pino | HIGH | 1–2 dias | ⬜ Pendente |
| 5 | Padronizar error handling (remover silent catch) | MEDIUM | 4–8 horas | ⬜ Pendente |
| 6 | WorkflowRunner — error listener no child process | MEDIUM | 1 hora | ⬜ Pendente |
| 7 | Log SSE parse failures no plugin | MEDIUM | 30 min | ⬜ Pendente |
| 8 | Constante POSITION_GAP | LOW | 15 min | ⬜ Pendente |
| 9 | Monorepo split (pnpm workspaces) | MEDIUM | 1–2 dias | ⬜ Pendente |

**Legenda:** ⬜ Pendente · 🔄 Em progresso · ✅ Concluído

---

## 1. Suite de Testes Automatizados — CRÍTICO ✅

**Problema:** Zero testes automatizados. `npm test` falha. Conflitos, reconciliação e lógica de sprint sem proteção nenhuma.

**Estado atual:** 267 testes passando em 16 arquivos, duração ~1.3s.

**Fase 1 — Unit tests (módulos puros) ✅:**
- `tests/unit/serialize.test.ts` — serialização/deserialização frontmatter
- `tests/unit/validation.test.ts` — validação de inputs
- `tests/unit/errors.test.ts` — factories de erro
- `tests/unit/slug.test.ts` — geração de slugs
- `tests/unit/layout.test.ts` — vault layout
- `tests/unit/tool-access.test.ts` — RBAC (isToolVisible por role)
- `tests/unit/tool-catalog.test.ts` — integridade estrutural do catálogo
- `tests/unit/tool-schemas.test.ts` — completude e consistência dos schemas
- `tests/unit/atomic.test.ts` — AtomicWriter (write, rename, hash, tmp cleanup)

**Fase 2 — Service tests (com SQLite :memory:) ✅:**
- `tests/service/card.test.ts` — conflict detection (409), position recalculation, claim/block/archive/bulkCreate/log
- `tests/service/sprint.test.ts` — pickNext() lógica, sprint state machine
- `tests/service/reconcile.test.ts` — startup reconciliation (DB ↔ .md files)
- `tests/service/auth.test.ts` — token validation, role-based access, edge cases
- `tests/service/idempotency.test.ts` — IdempotencyStore (load/prune/TTL/concurrent puts)
- `tests/service/sse.test.ts` — SSEEventBus (emit, history replay, rollover, unsubscribe)

**Fase 3 — Integration tests ✅:**
- `tests/integration/http.test.ts` — stack completo: HTTP → handler → DB → arquivo .md
  - Cobre: create/get card, idempotência, auth 401/403, RBAC 403, tool desconhecida 501, /health

**Cobertura:**
- `src/auth`: 93.7%
- `src/writer/atomic.ts`: 95.5%
- `src/server` (exceto `mcp-http.ts`): ~62% (mcp-http.ts não testado — encapsula SDK MCP sem lógica própria)

**Config:**
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

---

## 2. Vulnerabilidades de Dependência — HIGH

**Problema:** 3 CVEs em `npm audit`:
- **HIGH** — esbuild ≤0.28.0: RCE via missing binary integrity
- **MODERATE** — esbuild ≤0.28.0: Windows arbitrary file read
- **MODERATE** — gray-matter/js-yaml: quadratic DoS com merge keys

**Ação:**
```bash
npm update esbuild
npm update gray-matter
npm audit --fix
```

Verificar se update do esbuild quebra o build do plugin (`plugin/esbuild.config.mjs`).

**Verificação:** `npm audit` retorna zero vulnerabilidades.

---

## 3. Refactor CardService (God Object) — HIGH

**Problema:** `src/services/card.ts` com 1393 linhas e 12+ métodos misturando responsabilidades.

**Abordagem:** Extração incremental — cada extração é um PR independente e testável.

**Split proposto:**

| Módulo novo | Responsabilidades |
|---|---|
| `src/services/card-reader.ts` | `get`, `list`, query — extrai padrão `readFile + parseCardFile` (duplicado 7x) |
| `src/services/card-writer.ts` | `create`, `update`, `archive`, `delete` |
| `src/services/card-mover.ts` | `move`, `reorder`, position recalculation |
| `src/services/card-blocker.ts` | `block`, `unblock`, `claim`, `revert` |

`card.ts` vira façade compondo os 4 módulos — interface pública para `tool-catalog.ts` não muda.

**Padrão duplicado a extrair:** `readFile + parseCardFile` aparece 7x. Criar `src/vault/card-file.ts` com `readCardFile(path): Promise<Card>`.

**Ordem sugerida:** CardReader primeiro (elimina a duplicação), depois Writer, Mover, Blocker.

**Verificação:** Testes de fase 2 passam após cada extração; interface pública de `card.ts` inalterada.

---

## 4. Logging Estruturado com pino — HIGH

**Problema:** 35 `console.*` espalhados, prefixos ad-hoc, campo `logLevel` nunca usado, sem correlation IDs.

**Decisão:** **pino** — leve, JSON nativo, performance líder em servidores Node.

**Implementação:**
1. `npm install pino` + `npm install -D @types/pino`
2. Criar `src/util/logger.ts` — instância singleton com `level` lido de `LOG_LEVEL` env var
3. Substituir todos os 35 `console.*` em `src/` por chamadas do logger
4. Adicionar `requestId` como correlation ID nas rotas HTTP (`src/server/http.ts`)
5. Child loggers por contexto: `logger.child({ service: 'card' })`, `logger.child({ service: 'sprint' })`

**Exceção:** `src/auth/cli.ts` pode manter `console.*` por ser interface CLI interativa.

**Verificação:** `grep -r "console\." src/ | grep -v "cli.ts"` → zero results; logs em JSON válido; `LOG_LEVEL=debug` funciona.

---

## 5. Padronizar Error Handling — MEDIUM

**Problema:** Silent `.catch(() => null)` e `.catch(() => [])` em `src/vault/layout.ts`, `src/services/card.ts`, `src/vault/repository.ts`. Erros reais descartados silenciosamente.

**Regra:** Nunca silenciar um catch sem logar. Três padrões permitidos:

```typescript
// 1. Retornar default com log (erro esperado/aceitável)
.catch((err) => { logger.warn({ err }, 'descrição'); return null; })

// 2. Propagar (erro inesperado)
.catch((err) => { logger.error({ err }, 'descrição'); throw err; })

// 3. Silenciar (apenas se verdadeiramente irrelevante — exige comentário)
.catch(() => null) // ok porque: <motivo explícito>
```

**Arquivos a corrigir:**
- `src/vault/layout.ts`
- `src/services/card.ts`
- `src/vault/repository.ts`
- `plugin/src/view/board-view.ts` (SSE parse failures — ver item 7)

**Verificação:** `grep -r "catch(() =>" src/` → zero results.

---

## 6. WorkflowRunner — Error Listener — MEDIUM

**Problema:** `src/services/workflow-runner.ts` — child process sem listener para evento `error`. Falhas de spawn são silenciadas.

**Fix:** Adicionar listener no spawn:
```typescript
child.on('error', (err) => logger.error({ err }, 'workflow child process error'));
```

**Verificação:** Teste manual com caminho inválido → erro aparece nos logs.

---

## 7. Log SSE Parse Failures no Plugin — MEDIUM

**Problema:** `plugin/src/view/board-view.ts` — falhas de parse SSE ignoradas silenciosamente.

**Fix:**
```typescript
// antes: catch vazio
// depois:
catch (err) {
  console.warn('[ObsidianKan] SSE parse error:', err);
}
```

O plugin usa `console` (não tem acesso ao pino do servidor).

**Verificação:** SSE malformado aparece no console do Obsidian Developer Tools.

---

## 8. Constante POSITION_GAP — LOW

**Problema:** Magic number `1000` hardcoded em 5 lugares.

**Fix:** Criar `src/util/constants.ts`:
```typescript
export const POSITION_GAP = 1000;
```

Importar nos 5 pontos de uso em `src/services/card.ts` (e futuramente `card-mover.ts`).

**Verificação:** `grep -rn "= 1000" src/` → zero results relacionados a posição.

---

## 9. Monorepo Split — MEDIUM (priorizado)

**Problema:** Server, plugin e scripts num único `package.json` — build coupling, versioning acoplado, devDependencies misturadas.

**Estrutura proposta:**
```
obsidiankan/
  packages/
    server/          # src/ atual
    plugin/          # plugin/ atual
    shared/          # src/types.ts → @obsidiankan/types
    scripts/         # scripts/ atual
  package.json       # workspace root
  pnpm-workspace.yaml
```

**Tooling:** `pnpm workspaces` (sem Turborepo por enquanto).

**Dependência compartilhada:** `src/types.ts` (importado por 19/23 arquivos) move para `packages/shared/` como `@obsidiankan/types`.

**Verificação:** `pnpm --filter server build` e `pnpm --filter plugin build` funcionam independentemente.

---

## Ordem de Execução Sugerida

| Sprint | Itens | Esforço total |
|--------|-------|--------------|
| 1 | #2 vulnerabilidades + #8 POSITION_GAP + #6 WorkflowRunner + #7 SSE log | ~1 dia |
| 2 | #1 setup vitest + fase 1 unit tests | ~3 dias |
| 3 | #3 CardReader extraído + #1 fase 2 service tests (card) | ~4 dias |
| 4 | #3 CardWriter/Mover/Blocker extraídos | ~3 dias |
| 5 | #4 pino + #5 error handling | ~2 dias |
| 6 | #9 monorepo split | ~2 dias |
