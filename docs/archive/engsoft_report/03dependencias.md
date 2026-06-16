# 03 — Dependências

## Dependências de Produção

| Pacote                      | Versão   | Propósito                                                  | Risco                                                          |
| --------------------------- | -------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | ^1.29.0  | Protocolo MCP (transporte, schemas de tools)               | Baixo — API estável, vendor Anthropic                          |
| `@anthropic-ai/sdk`         | ^0.102.0 | Cliente da API Claude para o workflow runner               | Baixo — vendor próprio                                         |
| `better-sqlite3`            | ^11.5.0  | Banco SQLite síncrono de alta performance                  | Baixo — binário nativo, requer recompilação por versão do Node |
| `chokidar`                  | ^4.0.1   | Watch de sistema de arquivos para detectar edições humanas | Baixo — maturidade alta, sem deps problemáticas                |
| `gray-matter`               | ^4.0.3   | Parser de frontmatter YAML dos cards `.md`                 | **MODERATE** — ver vulnerabilidade abaixo                      |
| `nanoid`                    | ^5.0.7   | Geração de IDs aleatórios (`card-{nanoid(8)}`)             | Baixo                                                          |

## Dependências de Desenvolvimento

| Pacote | Versão | Propósito |
|--------|--------|-----------|
| `typescript` | ^5.6.3 | Compilador TypeScript |
| `tsx` | ^4.19.2 | Execução direta de `.ts` no dev |
| `esbuild` | ^0.28.0 | Build do plugin Obsidian | 
| `obsidian` | ^1.12.3 | Tipos da API Obsidian (devDep only) |
| `@types/better-sqlite3` | ^7.6.11 | Tipos do better-sqlite3 |
| `@types/node` | ^22.9.0 | Tipos do Node.js |
| `builtin-modules` | ^5.2.0 | Lista de módulos built-in para o build do plugin |

---

## Vulnerabilidades (npm audit — 2026-06-16)

**Total: 3 vulnerabilidades (1 HIGH, 2 MODERATE)**

| Severidade   | Pacote                             | CVE / Advisory                                                           | Descrição                                                          | Fix                              |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------- |
| **HIGH**     | `esbuild` ≤0.28.0                  | [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) | Missing binary integrity → RCE via `NPM_CONFIG_REGISTRY` malicioso | `npm audit fix`                  |
| **MODERATE** | `esbuild` ≤0.28.0                  | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | Dev server permite leitura arbitrária de arquivo no Windows        | `npm audit fix`                  |
| **MODERATE** | `gray-matter` via `js-yaml` ≤4.1.1 | [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | DoS quadrático com merge keys repetidas em YAML                    | `npm audit fix --force` (quebra) |

### Notas sobre mitigação

- **esbuild**: afeta apenas o build do plugin (devDependency). Não é exposto em produção. `npm audit fix` atualiza para a versão corrigida sem breaking changes.
- **gray-matter / js-yaml**: afeta a **produção** — `parseCardFile()` em `src/cards/serialize.ts` usa `gray-matter` para parsear frontmatter de todo card `.md` lido. Um card com YAML malformado contendo merge keys poderia causar DoS. `npm audit fix --force` faria downgrade para `gray-matter@2.0.1` (API diferente — mudança significativa). Alternativa: migrar para `js-yaml@4.1.2+` diretamente ou para `@iarna/toml` / frontmatter parser sem essa vulnerabilidade.

---

## Análise de Acoplamento

`src/types.ts` é o hub central de tipos do projeto. É importado por **19 dos 23 arquivos TypeScript** do servidor.

```
src/types.ts  ◀── importado por:
    ├── src/server/sse.ts
    ├── src/server/http.ts
    ├── src/server/mcp-http.ts
    ├── src/server/tool-access.ts
    ├── src/server/stdio.ts
    ├── src/index.ts
    ├── src/auth/validator.ts
    ├── src/services/admin.ts
    ├── src/services/query.ts
    ├── src/services/card.ts
    ├── src/services/validation.ts
    ├── src/services/sprint.ts
    ├── src/services/metrics.ts
    ├── src/audit/logger.ts
    ├── src/vault/layout.ts
    ├── src/cards/serialize.ts
    ├── src/cards/repository.ts
    ├── src/watcher/file-watcher.ts
    └── src/startup/reconcile.ts  (via serialize.ts)
```

Este padrão é **intencional e adequado** — `types.ts` é declarado no cabeçalho como "fonte de verdade para o contrato entre MCP Server, Plugin e agentes". O risco é que qualquer mudança de interface em `types.ts` requer revisão em todos os 19 importadores.

### Top 5 módulos por volume de responsabilidade

| Módulo                    | Linhas | Papel                           |
| ------------------------- | ------ | ------------------------------- |
| `src/services/card.ts`    | 1393   | Toda lógica de mutação de cards |
| `src/services/sprint.ts`  | 582    | Gestão de sprints               |
| `src/types.ts`            | 294    | Contratos de interface          |
| `src/cards/repository.ts` | 280    | SQLite CRUD de cards            |
| `src/server/http.ts`      | ~200   | Roteamento HTTP + auth          |

### Dependências circulares

Verificado via análise manual de imports: **não há dependências circulares** detectadas. O grafo de dependências é acíclico, com `types.ts` como raiz de tipos e `index.ts` como raiz de composição.

---

## Consideração sobre Estrutura do Projeto

O projeto é atualmente um **único pacote** (`obsidiankan-mcp`) que contém o servidor MCP, o plugin Obsidian e os scripts. O `package.json` tem scripts separados para cada componente (`build`, `build:plugin`, `typecheck:plugin`) mas não usa workspaces.

Isso simplifica o setup inicial mas cria acoplamento de build: `esbuild` (devDep do plugin) é instalado junto com as deps de produção em qualquer ambiente onde `npm install` seja executado. Ver recomendação de split monorepo em `06-problemas-e-recomendacoes.md`.
