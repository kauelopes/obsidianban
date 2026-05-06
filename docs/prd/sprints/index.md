# Plano de Implementação — ObsidianKanban MCP

Cada sprint é um conjunto de entregáveis coesos que podem ser testados e finalizados juntos. O critério de encerramento de um sprint é funcional — não temporal.

## Sprints

| Sprint | Nome | Entregável central | Pré-requisito |
|---|---|---|---|
| [Sprint 01](sprint-01-foundation.md) | Foundation | Infraestrutura base: vault, SQLite, atomic writer, file watcher, tokens, scaffold MCP | — |
| [Sprint 02](sprint-02-core-mcp-api.md) | Core MCP API | As 6 tools MCP com validação completa, 409/400, audit log | Sprint 01 |
| [Sprint 03](sprint-03-obsidian-plugin.md) | Obsidian Plugin | Board Kanban, drag-drop, SSE, acessibilidade, erros na UI, painel de métricas | Sprint 02 |
| [Sprint 04](sprint-04-hardening.md) | Hardening & Acceptance | E2E acceptance tests, stress test, guia de integração | Sprints 01–03 |

## Dependências entre sprints

```
Sprint 01 ──► Sprint 02 ──► Sprint 03
                                │
Sprint 01 ──────────────────────┤
                                ▼
                           Sprint 04
```

Sprint 03 depende de Sprint 01 (atomic writer, file watcher) e Sprint 02 (tools MCP).  
Sprint 04 depende dos três anteriores.

## Tipos de atividade

| Tipo | Descrição |
|---|---|
| `scaffold` | Estrutura inicial, boilerplate, setup de ambiente |
| `implementation` | Implementar funcionalidade nova |
| `integration` | Conectar componentes já existentes |
| `testing` | Escrever e executar testes |
| `hardening` | Compliance, edge cases, robustez |
| `documentation` | Guias, referências, docs técnicos |

Cada task tem exatamente um tipo. O tipo é definido na criação e não muda.

## Métricas de execução

Ao mover uma task para done, preencher a seção **Execução** no documento da task:
- **Agente:** identidade do agente que executou
- **Input tokens:** tokens de entrada consumidos
- **Output tokens:** tokens de saída gerados
- **Observações:** qualquer desvio do planejado, bloqueios encontrados ou decisões tomadas

---

## Critério de encerramento de cada sprint

- **Sprint 01:** MCP inicia, autentica tokens, file watcher reverte invariantes, SQLite reconstrói do zero
- **Sprint 02:** Suite completa de testes de API passa (sem UI) — todos os 6 tools, conflict, field rejection, audit log
- **Sprint 03:** Plugin instalado em vault de teste, board funcional, todos os RULE checks passando
- **Sprint 04:** Todos os 11 E2E acceptance tests (§14.3) com evidência documentada de pass
