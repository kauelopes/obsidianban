# 04 — Qualidade de Código

## 1. God Object: `src/services/card.ts` (1393 linhas)

`CardService` é responsável por **todas** as operações de card do sistema:

| Método | Responsabilidade |
|--------|-----------------|
| `createCard()` | Criação + posicionamento + escrita .md + SSE |
| `updateCard()` | Atualização de campos + conflict detection + SSE |
| `moveCard()` | Mudança de status + reposicionamento + SSE |
| `reorderCard()` | Reordenação entre cards + recálculo de posições + SSE |
| `deleteCard()` | Deleção + limpeza de referências de blocked_by |
| `archiveCard()` | Arquivamento soft + SSE |
| `unarchiveCard()` | Desarquivamento + reposicionamento |
| `blockCard()` / `unblockCard()` | Gestão de dependências entre cards |
| `revertField()` | Reversão de campo para valor anterior |
| `pickNext()` | Lógica de "qual card o dev deve pegar agora" |
| `claimCard()` / `releaseCard()` | Atribuição de card a agente |
| `logOnCard()` | Append de entrada de log ao body do card |
| `getCard()` / `listCards()` | Consultas |

Cada operação de mutação também gerencia: leitura/escrita de arquivo `.md`, atualização de SQLite, emissão de evento SSE e escrita no audit log. A classe centraliza lógica que deveria estar em serviços menores colaboradores.

---

## 2. Magic Number `1000` (posição de cards)

O espaçamento entre posições de cards é hardcoded como `1000` em **5 lugares distintos** em `card.ts`, sem constante nomeada:

| Linha | Contexto |
|-------|----------|
| `card.ts:249` | `position = (maxPos ?? 0) + 1000` — criação |
| `card.ts:469` | `merged.position = (maxPos ?? 0) + 1000` — mudança de status |
| `card.ts:574` | `newPosition = (maxPos ?? 0) + 1000` — move_card |
| `card.ts:674` | `newPos = (i + 1) * 1000` — reorder (recálculo completo) |
| `card.ts:997` | `newPosition = (maxPos ?? 0) + 1000` — revert de status |

A ausência de uma constante (`const POSITION_GAP = 1000`) significa que mudar a estratégia de espaçamento requer busca manual em múltiplos contextos.

---

## 3. Código Duplicado: `readFile + parseCardFile`

O padrão `readFile(filePath, 'utf8').then(parseCardFile)` (ou variante com `.catch(() => '')`) aparece **7 vezes** em `card.ts`:

| Linha | Código |
|-------|--------|
| `card.ts:557` | `parseCardFile(await fs.readFile(filePath, 'utf8'))` |
| `card.ts:631` | `parseCardFile(await fs.readFile(filePath, 'utf8'))` |
| `card.ts:747` | `.readFile(filePath, 'utf8').then(parseCardFile).then(p => p.body).catch(() => '')` |
| `card.ts:809` | `.readFile(filePath, 'utf8').then(parseCardFile).then(p => p.body).catch(() => '')` |
| `card.ts:892` | `.readFile(filePath, 'utf8').then(parseCardFile).then(p => p.body).catch(() => '')` |
| `card.ts:939` | `.readFile(filePath, 'utf8').then(parseCardFile).then(p => p.body).catch(() => '')` |
| `card.ts:975` | `.readFile(filePath, 'utf8').then(parseCardFile).then(p => p.body).catch(() => '')` |

A solução direta é um helper interno:

```typescript
async function readCardBody(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8').then(parseCardFile).then(p => p.body).catch(() => '')
}
```

---

## 4. Error Handling Inconsistente

### 4a. Erros silenciados em `vault/layout.ts`

```typescript
// vault/layout.ts:109
const meta = await loadProjectMeta(paths, project).catch(() => null)

// vault/layout.ts:115
const projects = await listProjects(paths).catch(() => [])

// vault/layout.ts:118
const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
```

Falhas de I/O ao listar projetos ou ler metadados são silenciosamente convertidas em `null`/`[]`. Se o vault estiver com permissões erradas ou corrompido, o servidor retornará respostas vazias sem nenhum sinal de erro no log.

### 4b. Empty catch em `cards/repository.ts`

```typescript
// cards/repository.ts:277
} catch {
  // sem log, sem rethrow
}
```

Exceção capturada e descartada sem registro — impossível diagnosticar posteriormente.

### 4c. Body silenciado em `card.ts`

Linhas 747, 809, 892, 939, 975 silenciam falhas de leitura do arquivo `.md` retornando string vazia:

```typescript
.catch(() => '')
```

Se um arquivo de card não puder ser lido (permissão, movido), operações que dependem do body (como `logOnCard`) silenciosamente sobrescreverão o conteúdo com string vazia.

---

## 5. Logging Não Estruturado

O projeto tem **35 chamadas de `console.*`** espalhadas pelo código, usando prefixos ad-hoc entre colchetes:

```
[startup] removed 2 orphan .tmp file(s)
[workflow] auto-launch enabled: script=...
[fatal] stdio: token validation failed
[shutdown] SIGTERM received
```

**Problemas:**
- Sem níveis semânticos (debug/info/warn/error) aplicados de forma consistente: `[startup]` usa tanto `console.log` quanto `console.error` para eventos informativos
- Sem correlation ID: impossível correlacionar log de uma request MCP com seus efeitos (write to DB, SSE emit, audit)
- Sem formato estruturado (JSON): dificulta ingestão em sistemas como Loki, Datadog ou CloudWatch
- `config.ts` define `logLevel` como campo mas **nenhum código lê este campo** para filtrar saída

---

## 6. WorkflowRunner sem Observabilidade de Falha

`src/services/workflow-runner.ts` faz spawn de um processo filho detached. Em **ambos** os branches (`logDir` configurado e não configurado), falta um listener de `'error'` no processo filho:

```typescript
// sem .on('error', handler) em nenhum dos dois branches
child.unref()
console.log(`[workflow] launched sprint=${sprintId} pid=${child.pid}`)
```

Se `node` não estiver no PATH, se `tsx` não estiver instalado, ou se o arquivo de script não existir, o processo falha silenciosamente. O servidor registra o PID como se o lançamento tivesse sido bem-sucedido, mas o workflow nunca executa.

No branch sem `logDir`, `stdio: 'ignore'` descarta stdout/stderr completamente, tornando o diagnóstico ainda mais difícil.

---

## 7. SSE Subscriber — Parse Silencioso

`plugin/src/mcp/sse-subscriber.ts:124-125`:

```typescript
data = JSON.parse(line.slice(6))
} catch {
  /* ignore malformed payload */
}
```

Falhas de parse de eventos SSE são descartadas sem log, sem métrica, sem sinalização. Em ambiente de produção, se o servidor enviar um evento com payload inválido (bug de serialização, truncamento de rede), o plugin simplesmente ignora o evento. O board pode ficar dessincronizado sem nenhuma indicação visível.

---

## Pontos Positivos

- **Convenções de nomenclatura consistentes**: `camelCase` para variáveis, `PascalCase` para tipos/classes, `UPPER_CASE` para constantes de esquema SQL
- **Interfaces bem definidas em `types.ts`**: o contrato entre componentes está explícito e centralizado
- **Separação de tipos de erro**: `src/services/errors.ts` tem helpers (`badRequest`, `conflict`, `forbidden`, `notFound`) que retornam `HttpError` com código HTTP correto
- **Atomic writes**: a escrita em dois passos (`.tmp` + `rename`) está corretamente abstraída em um único módulo
- **Auditoria completa**: todas as operações mutantes geram entradas em `audit.ndjson` com `actor`, `model` e contadores de tokens
- **Sem TODO/FIXME**: nenhuma anotação de débito técnico explícita no código — os problemas identificados não foram deixados como "para depois", são simplesmente código que nunca foi refatorado
