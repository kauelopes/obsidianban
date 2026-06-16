# ObsidianKan — CLAUDE.md

## Processo de melhoria ativo

Uma análise de engenharia de software foi conduzida em 2026-06-16 e identificou 9 problemas no projeto (score: 5.5/10). Estamos implementando as melhorias de forma incremental.

**PRD completo:** `docs/engsoft_report/07prd.md`  
**Análise original:** `docs/engsoft_report/` (arquivos 01–06)

No início de cada sessão, leia `docs/engsoft_report/07prd.md` para ver o que já foi feito (tabela de status no topo) e o que está pendente. Ao concluir um item, atualize o status na tabela para ✅.

### Resumo dos 9 itens (ordem de prioridade de execução)

1. ⬜ Corrigir vulnerabilidades (esbuild, gray-matter) — 1–2h
2. ⬜ POSITION_GAP como constante nomeada — 15min
3. ⬜ WorkflowRunner error listener — 1h
4. ⬜ Log SSE parse failures no plugin — 30min
5. ✅ Setup vitest + testes unit (fase 1) — concluído
6. ✅ CardReader extraído + testes service (fase 2) — concluído
6+. ✅ Testes server/writer/auth/integração (fase 3) — 267 testes no total
7. ⬜ CardWriter/Mover/Blocker extraídos — 3 dias
8. ⬜ pino + padronização de error handling — 2 dias
9. ⬜ Monorepo split com pnpm workspaces — 2 dias

---

## Sobre o projeto

**ObsidianKan** é um servidor MCP que expõe um sistema de Kanban persistido em arquivos Markdown dentro de um vault Obsidian. Inclui um plugin Obsidian para visualização e um workflow autônomo de sprint com agentes de IA.

**Stack:** Node.js 22, TypeScript 5.6, better-sqlite3, MCP SDK, esbuild, chokidar, gray-matter, nanoid

**Entry points:**
- `src/index.ts` — servidor HTTP/stdio MCP
- `src/auth/cli.ts` — CLI de tokens
- `plugin/src/main.ts` — plugin Obsidian
- `scripts/sprint-workflow.ts` — workflow autônomo com agentes

**Variáveis de ambiente obrigatórias:** `VAULT_PATH`, `MCP_HTTP_PORT`

**Build:**
```bash
npm run build        # compila server (src/)
npm run build:plugin # compila plugin Obsidian
```
