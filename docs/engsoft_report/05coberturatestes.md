# 05 — Cobertura de Testes

## Estado Atual: Zero Testes Automatizados

O script `test` no `package.json` referencia arquivos compilados que não existem:

```json
"test": "node --test --import tsx dist/**/*.test.js"
```

Executar `npm test` falha imediatamente — o glob `dist/**/*.test.js` não resolve nenhum arquivo. Não existe nenhum arquivo `.test.ts` ou `.test.js` no repositório.

Os scripts em `scripts/smoke-*.mjs` são testes manuais de integração: precisam de um servidor em execução, vault configurado e tokens válidos. Não são executáveis em CI sem setup completo de ambiente.

---

## Áreas de Risco sem Cobertura

### Alta criticidade

| Área | Arquivo | Risco |
|------|---------|-------|
| Conflict detection (version mismatch → 409) | `src/services/card.ts` | Regra central de consistência; qualquer regressão causa perda silenciosa de dados |
| Position recalculation após `reorderCard` | `src/services/card.ts:669-703` | Lógica de índice `(i+1)*1000` — erro resulta em posições duplicadas ou inversão de ordem |
| `pickNext()` blocked-by logic | `src/services/card.ts` | Agentes dev podem pegar cards bloqueados se a lógica de filtro estiver errada |
| Reconciliação startup DB ↔ .md | `src/startup/reconcile.ts` | Executada a cada restart; bug silencioso pode apagar dados do banco |
| Token validation (Bearer → claims) | `src/auth/validator.ts` + `src/auth/tokens.ts` | Falha de segurança se token inválido for aceito |

### Média criticidade

| Área | Arquivo | Risco |
|------|---------|-------|
| Atomic write (`.tmp` + rename) | `src/writer/atomic.ts` | Corrupção de arquivo em falha de disco |
| Idempotência por `request_id` | `src/server/idempotency.ts` | Duplicação de cards em retries |
| SSE replay por `Last-Event-ID` | `src/server/sse.ts` | Perda de eventos em reconexão |
| Serialização/deserialização frontmatter | `src/cards/serialize.ts` | Cards corrompidos silenciosamente |
| Acesso por role (`tool-access.ts`) | `src/server/tool-access.ts` | Agente dev podendo executar operações de pm |

---

## Smoke Scripts Existentes

Os scripts manuais cobrem os seguintes fluxos (requerem servidor ativo):

| Script | Fluxo testado |
|--------|--------------|
| `smoke-bulk-create.mjs` | Criação em volume de cards |
| `smoke-realtime.mjs` | SSE pub/sub em tempo real |
| `smoke-sprints.mjs` | Ciclo de vida de sprints |
| `smoke-migration.mjs` | Migração de banco |
| `smoke-batch*.mjs` | Fluxos de batch variados |
| `smoke-sprint04-*.mjs` | Cenários de acceptance sprint 4 |

Esses scripts são **valiosos como ponto de partida** para testes de integração automatizados, mas precisam ser refatorados para funcionar sem servidor externo (usando banco in-memory ou fixtures).

---

## Plano Sugerido de Testes

### Fase 1: Unit Tests (sem I/O)

Prioridade máxima. Usar **`node:test`** (já disponível no Node 22) ou **vitest** (se preferir watch mode e coverage integrados).

**Alvos imediatos:**

1. `src/cards/serialize.ts` — testes de `parseCardFile()` e `formatCard()` com strings de frontmatter fixas
2. `src/services/validation.ts` — testes de `requireString()`, `optInt()`, `optPriority()` etc.
3. `src/services/errors.ts` — testes de `conflict()`, `badRequest()` com campos esperados
4. `src/cards/slug.ts` — testes de `slugifyTitle()` com casos de borda (UTF-8, colisão)

### Fase 2: Tests de Serviço (com SQLite in-memory)

`better-sqlite3` suporta banco `:memory:`. Criar fixtures que inicializam o schema e inserem dados.

**Alvos:**

1. `src/services/card.ts#createCard()` — verificar posição, version=1, eventos SSE emitidos
2. `src/services/card.ts#moveCard()` — verificar conflito de versão (409), nova posição
3. `src/services/card.ts#reorderCard()` — verificar recálculo de posições dos cards afetados
4. `src/startup/reconcile.ts` — reconciliação com vault simulado em memória

### Fase 3: Integration Tests

Subir servidor em porta efêmera, executar fluxos completos via HTTP. Pode reutilizar a lógica dos `smoke-*.mjs` existentes.

### Estrutura sugerida de arquivos

```
src/
  cards/
    serialize.test.ts
    slug.test.ts
    repository.test.ts
  services/
    card.test.ts        # maior esforço, maior valor
    validation.test.ts
    errors.test.ts
  startup/
    reconcile.test.ts
  server/
    tool-access.test.ts
```

### Script npm corrigido

```json
"test": "node --test --import tsx src/**/*.test.ts",
"test:watch": "node --test --watch --import tsx src/**/*.test.ts"
```

Ou com vitest:

```json
"test": "vitest run",
"test:watch": "vitest"
```
