# Task: Evitar cascata de cards dependentes em review

## Problema

No workflow atual, quando um card bloqueia e vai para `review`, o agente continua
chamando `kanban_pick_next`. Se o próximo card depende do primeiro, ele pode tentar
executar esse trabalho, descobrir a dependência durante a execução e mover também
esse segundo card para `review`.

Em uma cadeia bloqueada por uma única decisão humana, isso cria ruído: vários cards
aparecem como pendência de review quando somente o card raiz precisa de intervenção.

## Objetivo

Manter `review` reservado para cards que exigem julgamento humano direto. Cards que
estão apenas esperando outro card devem ser adiados por dependência, continuar fora
da inbox humana e voltar automaticamente ao fluxo quando o blocker for resolvido.

## Regra de produto

- Se o card atual está bloqueado por uma decisão, informação ou erro próprio, ele
  pode ir para `review`.
- Se o card atual depende de outro card existente, inclusive um card que já está em
  `review`, ele não deve ir para `review`.
- Nesse caso, o card atual deve registrar a dependência em `blocked_by`, liberar o
  claim do agente e voltar para uma coluna não iniciada (`todo`, ou `blocked` se essa
  coluna for introduzida no futuro).
- O card dependente só volta a ser elegível quando todos os seus blockers estiverem
  satisfeitos.
- No modelo atual, um blocker está satisfeito quando seu card está em `done`,
  arquivado ou deletado. Um blocker em `review` ou que voltou para `todo` continua
  bloqueando.

## Proposta técnica

Criar uma operação dev-safe para adiar um card por dependência:

```ts
kanban_defer_card {
  id: string
  version: number
  blocked_by: string[]
  log_entry: string
  request_id?: string
}
```

A operação deve ser atômica e executar:

1. validar permissão e ownership do card;
2. validar `blocked_by` com as mesmas regras de `kanban_update_card`;
3. mesclar os novos blockers com os blockers existentes, sem duplicar ids;
4. gravar uma entrada no `# Agent Log`;
5. limpar `assigned_to`;
6. mover o card para `todo` se ele estiver em uma coluna iniciada;
7. emitir SSE/audit/token log conforme os padrões atuais.

O objetivo é evitar que o agente precise combinar manualmente
`kanban_update_card`, `kanban_log_on_card`, `kanban_release_card` e
`kanban_move_card`, porque essa sequência é fácil de quebrar em conflitos de versão.

## Mudanças no workflow

Atualizar o prompt do dev em `packages/server/scripts/sprint-workflow.ts`:

- ao descobrir que o card atual depende de outro card, chamar `kanban_defer_card`;
- se o blocker estiver em `review`, mencionar no log que o card está aguardando a
  decisão do blocker;
- depois de deferir, parar o round ou chamar `kanban_pick_next`, conforme
  `DEV_DRAIN_LIMIT`;
- só mover para `review` quando o próprio card precisa de decisão humana.

Atualizar também a documentação de agente:

- `docs/for-agents/agent-runbook.md`;
- `docs/for-agents/integration-guide.md`;
- `docs/for-agents/tool-catalog.md`;
- schemas e catálogo MCP se a tool nova for exposta.

## Comportamento esperado

Exemplo:

1. `CARD-A` vai para `review` porque precisa de uma decisão humana.
2. O agente pega `CARD-B`.
3. Durante a execução, descobre que `CARD-B` depende de `CARD-A`.
4. O agente chama `kanban_defer_card` em `CARD-B` com `blocked_by: ["CARD-A"]`.
5. `CARD-B` volta para `todo` sem aparecer como pendência humana.
6. Enquanto `CARD-A` estiver em `review` ou `todo`, `kanban_pick_next` ignora
   `CARD-B`.
7. Quando `CARD-A` for para `done`, `CARD-B` volta a ser elegível no
   `kanban_pick_next`.

## Critérios de aceite

- Um card dependente de outro card em `review` não é movido para `review`.
- O card dependente recebe `blocked_by` corretamente e libera `assigned_to`.
- `kanban_pick_next` não retorna o card dependente enquanto o blocker não estiver
  satisfeito.
- Quando o blocker vai para `done`, o card dependente volta a ser retornável por
  `kanban_pick_next`.
- O histórico do card mostra por que ele foi adiado.
- A inbox humana mostra apenas o blocker raiz, não a cascata de dependentes.
- Há testes cobrindo blocker em `review`, blocker resolvido em `done` e merge de
  `blocked_by` existente.

## Testes sugeridos

- Service test para `kanban_defer_card`:
  - cria `A` em `review`;
  - cria `B` em `in_progress`, claimed pelo dev;
  - defer de `B` por `A`;
  - valida `B.status === "todo"`, `B.assigned_to === null` e
    `B.blocked_by.includes(A.id)`.
- Service test para `kanban_pick_next`:
  - com `A` em `review`, `B` nao aparece;
  - com `A` em `done`, `B` aparece.
- Teste de conflito:
  - defer com version antiga retorna `409` e inclui estado atual.
- Teste de validação:
  - blocker inexistente, cross-project e ciclo continuam recusados.

## Decisão pendente

Avaliar se vale criar uma coluna visual `blocked`. Tecnicamente não é necessária,
porque `blocked_by` + `pick_next` já resolvem o fluxo. Produto pode se beneficiar
da coluna se humanos precisarem enxergar explicitamente o trabalho pausado, mas ela
não deve entrar na inbox de review.
