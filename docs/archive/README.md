# Arquivo Histórico

Esta pasta contém documentação gerada durante o planejamento e as iterações do projeto ObsidianKan. **Não reflete o estado atual da implementação** — é mantida apenas como registro histórico de decisões e evolução do projeto.

## Conteúdo

| Pasta/Arquivo | Período | Descrição |
|---|---|---|
| `engsoft_report/` | 2026-06-16 | Auditoria de engenharia de software (score 5.5/10). Originou as 9 melhorias implementadas. Todas concluídas. |
| `prd/` | Sprints 0–4 | Documentos de requisitos de produto. 16 seções + planejamentos de sprint. |
| `sprint-01-foundation.md` | Sprint 1 | Fundação: server, auth, reconciliação |
| `sprint-02-core-mcp-api.md` | Sprint 2 | API MCP core, RBAC, catálogo de tools |
| `sprint-03-obsidian-plugin.md` | Sprint 3 | Plugin Obsidian, board view, SSE |
| `sprint-04-hardening.md` | Sprint 4 | Testes, error handling, observabilidade |
| `sprint-04-acceptance-report.md` | Sprint 4 | Relatório de aceitação do Sprint 4 |
| `design-plugin.md` | Sprint 3 | Class design do Plugin Obsidian, normativo até a remoção do pacote na fase 5 da migração web |
| `handoff-fase4-ui.md` | 2026-07 | Snapshot pontual do fim da fase 4 da migração web; referencia `packages/plugin`, removido desde então. Superado por `docs/prd-web-migration.md` (status: concluído) |
| `2026-07-30-long-running-jobs.md` | 2026-07-30 | Plano de design do subsistema Jobs (comandos de longa duração administrados pelo servidor). Implementado — ver `docs/for-developers/architecture.md` §A6 |
| `2026-07-30-project-settings-tabs.md` + `-design.md` | 2026-07-30 | Plano/spec das abas de configuração do projeto (`ProjectPanel.tsx`). Implementado |
| `2026-07-30-sprint-wizard-editable-tasks.md` + `-design.md` | 2026-07-30 | Plano/spec da lista de tarefas editável no wizard de sprint-planning (`StepTaskList`). Implementado |
| `2026-07-30-sprint-wizard-free-text-objective.md` + `-design.md` | 2026-07-30 | Plano/spec da simplificação do wizard de sprint-planning (objetivo em texto livre, sem etapa de capacidade, sem vínculo de épico). Implementado — ver `docs/for-agents/integration-guide.md` §7 |

Para a documentação atual e funcional, veja [`docs/`](../).
