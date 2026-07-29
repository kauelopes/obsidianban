# Guia de Contribuição — ObsidianKan

---

## Convenções de código

### TypeScript

- **Strict mode** em todos os pacotes — sem `any` implícito, null checks obrigatórios
- **NodeNext** module resolution no server — imports com extensão `.js` (mesmo em `.ts`)
- **Sem comentários óbvios** — o código deve ser autoexplicativo; comente apenas o "por quê" não óbvio
- **Sem error handling desnecessário** — não adicione fallbacks para cenários impossíveis

### Logging

Use o logger centralizado do pino, nunca `console.log`:

```typescript
import { logger } from '../util/logger.js'

logger.info({ cardId, status }, 'card movido')
logger.error({ err, cardId }, 'falha ao mover card')
```

Campos de contexto antes da mensagem, seguindo a convenção pino.

### Constantes

Valores mágicos pertencem a `packages/server/src/util/constants.ts`:

```typescript
// Adicione aqui, não inline no código
export const NOVA_CONSTANTE = 42
```

### Erros customizados

Use os tipos de erro em `packages/server/src/services/errors.ts`:

- `ConflictError` — versão desatualizada (409)
- `ValidationError` — campo inválido (400)
- `NotFoundError` — recurso não encontrado (404)

---

## Onde adicionar código novo

| O que estou adicionando | Onde vai |
|---|---|
| Nova tool MCP | `tool-catalog.ts` (metadados) + `tool-schemas.ts` (schema) + `index.ts` (handler) |
| Novo serviço de negócio | `packages/server/src/services/` |
| Novo tipo de domínio | `packages/shared/src/index.ts` |
| Nova util pura | `packages/server/src/util/` |
| Nova operação de vault (arquivo) | `packages/server/src/vault/` |
| Novo componente do web app | `packages/web/src/ui/` |

### Adicionando uma nova tool MCP

1. Defina o schema em `src/server/tool-schemas.ts`
2. Adicione metadados (nome, descrição, acesso) em `src/server/tool-catalog.ts`
3. Registre o handler em `src/index.ts` no switch de tools
4. Atualize a matriz de acesso em `src/server/tool-access.ts` se necessário
5. Regenere a documentação: `pnpm run gen:tools`
6. Adicione teste em `tests/unit/tool-schemas.test.ts` e `tool-access.test.ts`

---

## Estrutura de um PR

1. **Um PR por feature/fix** — sem commits acumulados de múltiplas mudanças
2. **Testes passando:** `pnpm run test` deve passar localmente
3. **Type check limpo:** `pnpm run typecheck`
4. **Build funcional:** `pnpm run build`

### Mensagens de commit

```
feat: adicionar kanban_bulk_archive_cards
fix: corrigir race condition no claim_card com versão desatualizada
refactor: extrair lógica de triagem para triage-service.ts
test: adicionar testes para fluxo de close_sprint
docs: atualizar catálogo de tools após bulk_archive
```

Prefixos: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

---

## Atualizando o catálogo de tools

O arquivo `docs/for-agents/tool-catalog.md` é **auto-gerado**. Não edite manualmente.

```bash
# Após alterar tool-catalog.ts ou tool-schemas.ts:
~/.local/share/pnpm/bin/pnpm run gen:tools
# Commit o arquivo gerado junto com as mudanças no código
```

---

## Tipos compartilhados

Alterações em `packages/shared/src/index.ts` afetam tanto o server quanto o web app. Após qualquer alteração:

```bash
# Recompilar shared primeiro
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/types build

# Depois recompilar dependentes
~/.local/share/pnpm/bin/pnpm run build
~/.local/share/pnpm/bin/pnpm run build:web
```

---

## Checklist antes de abrir PR

- [ ] `pnpm run test` — todos os 267+ testes passando
- [ ] `pnpm run typecheck` — sem erros de tipo
- [ ] `pnpm run build` — compila sem erros
- [ ] `pnpm run gen:tools` — se alterou tools MCP
- [ ] Testes adicionados para o novo comportamento
- [ ] Sem `console.log` no código de produção
