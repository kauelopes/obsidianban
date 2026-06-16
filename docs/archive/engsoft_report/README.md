# Relatório de Engenharia de Software — ObsidianKan MCP

**Projeto:** `obsidiankan-mcp`
**Data:** 2026-06-16
**Nota geral:** 5.5 / 10

---

## Sumário Executivo

O ObsidianKan MCP é um sistema Kanban para agentes de IA e humanos composto por um servidor MCP em Node.js/TypeScript e um plugin Obsidian. A arquitetura tem decisões sólidas — arquivos `.md` como fonte de verdade, SQLite como índice derivado, escrita atômica e versionamento otimista — mas a implementação acumula dívida técnica significativa: o único serviço de domínio tem 1393 linhas sem decomposição, não existe nenhum teste automatizado, e há 3 vulnerabilidades conhecidas nas dependências de desenvolvimento.

### Pontos Fortes
- Escrita atômica (`writer/atomic.ts`) evita corrupção de dados em falhas parciais
- Versionamento otimista (campo `version`) com resposta 409 em conflito
- Sistema de tipos bem definido em `src/types.ts` — contrato único entre servidor, plugin e agentes
- Buffer de replay SSE (100 eventos) permite reconexão sem perda de eventos
- Trilha de auditoria em NDJSON (`audit.ndjson`) rastreia todas as mutações
- Reconciliação na inicialização sincroniza DB ↔ arquivos .md sem intervenção manual

### Problemas Críticos
- **Zero testes automatizados** — `npm test` falha com arquivo inexistente
- **God object `card.ts`** (1393 linhas) com responsabilidades misturadas
- **3 vulnerabilidades** nas dependências (1 HIGH, 2 MODERATE)
- **Logging não estruturado** — 35 chamadas de `console.*` sem níveis ou correlation IDs
- **Erros silenciados** em `.catch(() => null)` e blocos `catch {}` vazios

---

## Índice

| #   | Seção                                                          | Conteúdo                                                     |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | [Visão Geral](01-visao-geral.md)                               | Propósito, stack, estrutura, entry points                    |
| 2   | [Arquitetura](./02-arquitetura.md)                             | Camadas, componentes, decisões arquiteturais, fluxo de dados |
| 3   | [Dependências](./03-dependencias.md)                           | Inventário, vulnerabilidades, acoplamento                    |
| 4   | [Qualidade de Código](./04-qualidade-codigo.md)                | God object, duplicação, error handling, logging              |
| 5   | [Cobertura de Testes](./05-cobertura-testes.md) —              | Estado atual (zero), riscos, plano sugerido                  |
| 6   | [Problemas e Recomendações](./06-problemas-e-recomendacoes.md) | Lista priorizada de melhorias                                |
