import { useRef, useState, type MutableRefObject } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
  type Over,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import type { CardSummary, Sprint } from '@obsidiankan/types'
import { authorClass } from '../card/author.js'
import { isOverdue, todayString, type ProjectGroup } from './group.js'

const DRAG_INSTRUCTIONS_ID = 'board-drag-instructions'

interface Props {
  groups: ProjectGroup[]
  onMove: (card: CardSummary, toStatus: string) => void
  /**
   * Reordena dentro da própria coluna. `afterCardId` null = para o topo.
   * kanban_reorder_card existe no servidor desde sempre e nunca teve UI.
   */
  onReorder: (card: CardSummary, afterCardId: string | null) => void
  /** Server-side rules mirrored as UX hints only — the server stays the authority. */
  moveHint: (card: CardSummary, toStatus: string) => string | null
  /** Ids com escalação pendente — mesma fonte que a inbox. */
  escalated: ReadonlySet<string>
  showArchived: boolean
  onShowArchived: (v: boolean) => void
  onCreateCard: (project: string) => void
  onOpenSprints: (project: string) => void
  onOpenProject: (project: string) => void
  sprintFilter: Record<string, string | undefined>
  onSprintFilter: (project: string, sprintId: string | undefined) => void
  sprintsFor: (project: string) => readonly Sprint[]
}

export function Board({
  groups,
  onMove,
  onReorder,
  escalated,
  showArchived,
  onShowArchived,
  moveHint,
  onCreateCard,
  onOpenSprints,
  onOpenProject,
  sprintFilter,
  onSprintFilter,
  sprintsFor,
}: Props) {
  const [dragging, setDragging] = useState<CardSummary | null>(null)
  // Um drag solto dispara um click no mesmo card logo em seguida; o flag vive
  // só até o fim do tick para esse click não virar navegação acidental.
  const justDragged = useRef(false)
  const sensors = useSensors(
    // A small threshold keeps a click on the card from starting a drag, so
    // the link to the detail view still works.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Setas reordenam dentro da coluna e também movem entre colunas —
    // sortableKeyboardCoordinates opera por geometria sobre todos os
    // droppables do DndContext, não só os da lista atual. Verificado em
    // browser real: jsdom não calcula layout, então esse comportamento não
    // aparece em teste automatizado.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const announcements: Announcements = {
    onDragStart({ active }) {
      const card = (active.data.current as { card: CardSummary } | undefined)?.card
      return card ? `Pegou o card ${card.title}.` : undefined
    },
    onDragOver({ active, over }) {
      const card = (active.data.current as { card: CardSummary } | undefined)?.card
      if (!card) return undefined
      const desc = describeTarget(groups, card, over)
      return desc ? `Sobre ${desc}.` : undefined
    },
    onDragEnd({ active, over }) {
      const card = (active.data.current as { card: CardSummary } | undefined)?.card
      if (!card) return undefined
      const desc = describeTarget(groups, card, over)
      return desc ? `${card.title} solto em ${desc}.` : `${card.title} solto sem mudança de posição.`
    },
    onDragCancel({ active }: DragCancelEvent) {
      const card = (active.data.current as { card: CardSummary } | undefined)?.card
      return card ? `Movimento de ${card.title} cancelado.` : 'Movimento cancelado.'
    },
  }

  function handleStart(e: DragStartEvent) {
    setDragging((e.active.data.current as { card: CardSummary } | undefined)?.card ?? null)
  }

  /**
   * Um drop pode significar duas coisas, e o alvo diz qual:
   *   - id de coluna ("<projeto> <status>") → mover entre colunas
   *   - id de card                          → reordenar, ou mover se o card
   *                                           alvo está em outra coluna
   */
  function handleEnd(e: DragEndEvent) {
    const card = (e.active.data.current as { card: CardSummary } | undefined)?.card
    setDragging(null)
    justDragged.current = true
    setTimeout(() => {
      justDragged.current = false
    }, 0)
    if (!card || !e.over) return

    const overId = String(e.over.id)
    const overCard = (e.over.data.current as { card?: CardSummary } | undefined)?.card

    if (!overCard) {
      // Espaço vazio da coluna.
      const [project, status] = splitDroppableId(overId)
      if (project !== card.project || status === card.status) return
      onMove(card, status)
      return
    }

    if (overCard.project !== card.project) return
    if (overCard.id === card.id) return

    if (overCard.status !== card.status) {
      onMove(card, overCard.status)
      return
    }

    // Mesma coluna: reordenar.
    const list = columnCards(groups, card.project, card.status)
    const after = afterCardIdFor(list, card.id, overCard.id)
    if (after === undefined) return
    onReorder(card, after)
  }

  const total = groups.reduce(
    (n, g) => n + Object.values(g.cards).reduce((m, arr) => m + arr.length, 0),
    0,
  )

  /*
   * Só a ausência de PROJETO justifica tomar a tela inteira.
   *
   * Antes, zero cards visíveis também disparava esta saída — e como os botões
   * "+ card", "sprints" e "ajustes" moram no cabeçalho do projeto, um vault com
   * todos os cards arquivados (que é o estado real do projeto avare) virava uma
   * frase solta num fundo vazio, sem nenhuma via de criar o que faltava.
   */
  if (groups.length === 0) {
    return (
      <div className="board">
        <p className="empty-lg">
          Nenhum projeto ainda. Crie o primeiro em <strong>+ projeto</strong>, na barra de cima.
        </p>
      </div>
    )
  }

  const today = todayString()

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleStart}
      onDragEnd={handleEnd}
      onDragCancel={() => setDragging(null)}
      accessibility={{ announcements }}
    >
      <div className="board">
        {/*
          Aviso que não bloqueia: os projetos continuam na tela, com as ações de
          cabeçalho acessíveis. E oferece a ação em vez de mandar procurar um
          checkbox na barra de cima.
        */}
        {total === 0 && !showArchived && (
          <p className="notice">
            Nenhum card visível. Fechar uma sprint arquiva os cards em “done”, então um projeto
            já concluído aparece vazio.
            <button onClick={() => onShowArchived(true)}>mostrar arquivados</button>
          </p>
        )}
        {groups.map((g) => {
          const count = Object.values(g.cards).reduce((n, arr) => n + arr.length, 0)
          return (
            <section className="project" key={g.project}>
              <div className="project-head">
                <h2>{g.project}</h2>
                <span className="label">
                  {count} card{count === 1 ? '' : 's'}
                </span>
                <div className="spacer" />
                <select
                  aria-label={`Filtrar sprint de ${g.project}`}
                  value={sprintFilter[g.project] ?? ''}
                  onChange={(e) => onSprintFilter(g.project, e.target.value || undefined)}
                >
                  <option value="">todas as sprints</option>
                  {sprintsFor(g.project).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.status}
                    </option>
                  ))}
                </select>
                <button onClick={() => onCreateCard(g.project)}>+ card</button>
                <button onClick={() => onOpenSprints(g.project)}>sprints</button>
                <button
                  className="ghost"
                  onClick={() => onOpenProject(g.project)}
                  title="Repositório, tokens de agente, arquivar e deletar"
                >
                  ajustes
                </button>
              </div>
              <div className="columns">
                {g.columns.map((status) => (
                  <Column
                    key={status}
                    project={g.project}
                    status={status}
                    cards={g.cards[status] ?? []}
                    today={today}
                    dragging={dragging}
                    moveHint={moveHint}
                    escalated={escalated}
                    justDragged={justDragged}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
      <DragOverlay>
        {dragging ? (
          <div className={`card${authorClass(dragging.updated_by)}`} style={{ cursor: 'grabbing' }}>
            <CardBody card={dragging} today={today} escalated={escalated.has(dragging.id)} />
          </div>
        ) : null}
      </DragOverlay>
      <span id={DRAG_INSTRUCTIONS_ID} className="sr-only">
        Pressione espaço para pegar o card, use as setas para mover, espaço para soltar, esc para
        cancelar.
      </span>
    </DndContext>
  )
}

function droppableId(project: string, status: string): string {
  return `${project} ${status}`
}

function splitDroppableId(id: string): [string, string] {
  const i = id.indexOf(' ')
  return [id.slice(0, i), id.slice(i + 1)]
}

/**
 * Descreve em texto o alvo de um drop, para os `announcements` do DndContext.
 * Mesma leitura de `over` que `handleEnd` usa para decidir mover vs. reordenar,
 * para o anúncio nunca divergir do que de fato acontece.
 */
function describeTarget(
  groups: ProjectGroup[],
  card: CardSummary,
  over: Over | null,
): string | undefined {
  if (!over) return undefined
  const overId = String(over.id)
  const overCard = (over.data.current as { card?: CardSummary } | undefined)?.card

  if (!overCard) {
    const [project, status] = splitDroppableId(overId)
    if (project !== card.project || status === card.status) return undefined
    return `coluna ${status.replace(/_/g, ' ')}`
  }

  if (overCard.project !== card.project || overCard.id === card.id) return undefined

  if (overCard.status !== card.status) {
    return `coluna ${overCard.status.replace(/_/g, ' ')}`
  }

  const list = columnCards(groups, card.project, card.status)
  const after = afterCardIdFor(list, card.id, overCard.id)
  if (after === undefined) return undefined
  return after === null
    ? `topo da coluna ${card.status.replace(/_/g, ' ')}`
    : `posição de ${overCard.title}`
}

function columnCards(
  groups: ProjectGroup[],
  project: string,
  status: string,
): CardSummary[] {
  return groups.find((g) => g.project === project)?.cards[status] ?? []
}

/**
 * Traduz "soltei o card A sobre o card B" no `after_card_id` que
 * kanban_reorder_card espera: o id do card que deve ficar imediatamente ANTES,
 * ou null para o topo da coluna.
 *
 * A direção importa. Arrastando para baixo, o alvo passa a ficar acima do card
 * movido; arrastando para cima, abaixo. Sem esse ajuste o card cai sempre uma
 * posição fora do lugar onde foi solto.
 *
 * Devolve `undefined` quando o movimento não faz sentido, para o chamador
 * poder desistir sem enviar nada.
 */
export function afterCardIdFor(
  list: readonly CardSummary[],
  activeId: string,
  overId: string,
): string | null | undefined {
  const from = list.findIndex((c) => c.id === activeId)
  const to = list.findIndex((c) => c.id === overId)
  if (from === -1 || to === -1 || from === to) return undefined

  const without = list.filter((c) => c.id !== activeId)
  const overIdx = without.findIndex((c) => c.id === overId)
  const insertIdx = from < to ? overIdx + 1 : overIdx
  return insertIdx === 0 ? null : (without[insertIdx - 1]?.id ?? null)
}

function Column({
  project,
  status,
  cards,
  today,
  dragging,
  moveHint,
  escalated,
  justDragged,
}: {
  project: string
  status: string
  cards: CardSummary[]
  today: string
  dragging: CardSummary | null
  moveHint: Props['moveHint']
  escalated: ReadonlySet<string>
  justDragged: MutableRefObject<boolean>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId(project, status) })
  const hint = dragging && dragging.project === project ? moveHint(dragging, status) : null
  const blocked = hint != null

  return (
    <div
      ref={setNodeRef}
      className={`column${isOver && !blocked ? ' over' : ''}${blocked ? ' blocked' : ''}`}
    >
      <div className="column-head">
        <span>{status.replace(/_/g, ' ')}</span>
        <span className="count">{cards.length}</span>
      </div>
      {cards.length === 0 ? (
        <p className="empty">vazio</p>
      ) : (
        <div className="column-body">
          <SortableContext
            items={cards.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {cards.map((c) => (
              <DraggableCard
                key={c.id}
                card={c}
                today={today}
                escalated={escalated.has(c.id)}
                justDragged={justDragged}
              />
            ))}
          </SortableContext>
        </div>
      )}
      {/*
        O motivo de um drop recusado fica na tela, não só no title=. Antes era
        invisível no toque e para leitor de tela. Continua sendo hint de UX: o
        drop não é bloqueado aqui, quem decide é o 409 do servidor.
      */}
      {blocked && <p className="hint">{hint}</p>}
    </div>
  )
}

function DraggableCard({
  card,
  today,
  escalated,
  justDragged,
}: {
  card: CardSummary
  today: string
  escalated: boolean
  justDragged: MutableRefObject<boolean>
}) {
  const navigate = useNavigate()
  // useSortable em vez de useDraggable: é o que dá o alvo de drop por card, e
  // portanto o reorder dentro da coluna.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { card },
  })

  /**
   * O card inteiro navega, não só o título: o corpo era apenas alça de drag e
   * clicar nele não fazia nada. O threshold de 4px do PointerSensor separa
   * clique de drag; o flag cobre o click sintético que chega depois do drop.
   * O <a> do título continua por cima (teclado, middle-click) e fica de fora
   * para não navegar duas vezes.
   */
  function onClick(e: React.MouseEvent) {
    if (justDragged.current) return
    if ((e.target as HTMLElement).closest('a')) return
    navigate(`/card/${card.id}`)
  }

  return (
    <div
      ref={setNodeRef}
      className={`card${authorClass(card.updated_by)}${escalated ? ' escalated' : ''}${card.archived ? ' archived' : ''}${isDragging ? ' dragging' : ''}`}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
      }}
      onClick={onClick}
      {...listeners}
      {...attributes}
      aria-describedby={DRAG_INSTRUCTIONS_ID}
    >
      <span className="card-drag-handle" aria-hidden="true" />
      <CardBody card={card} today={today} escalated={escalated} />
    </div>
  )
}

/**
 * Slots de ordem fixa na linha de meta — id, prioridade, prazo, responsável —
 * para o olho poder varrer a coluna verticalmente sem reler cada card.
 */
const VISIBLE_TAGS = 3

function CardBody({
  card,
  today,
  escalated = false,
}: {
  card: CardSummary
  today: string
  escalated?: boolean
}) {
  const overdue = isOverdue(card.due_date, today)
  // Sinais que exigem decisão imediata dominam a leitura do card; id,
  // responsável e tags são rastreio administrativo e cedem peso quando há um.
  const hasAlert = escalated || card.blocked_by.length > 0 || (overdue && card.priority === 'critical')
  const visibleTags = card.tags.slice(0, VISIBLE_TAGS)
  const hiddenTags = card.tags.length - visibleTags.length

  return (
    <>
      <div className="card-title">
        <Link to={`/card/${card.id}`}>{card.title}</Link>
      </div>
      <div className="card-meta">
        {/*
          Glifo + palavra, na frente da linha de meta: uma escalação é a única
          coisa do board que exige ação do humano, então ocupa o primeiro slot.
        */}
        {escalated && (
          <span className="flag escalated" title="Esperando sua decisão">
            ▲ escalado
          </span>
        )}
        <span className={`card-meta-admin${hasAlert ? ' dim' : ''}`}>
          <span className="id">{card.id.replace(/^card-/, '')}</span>
          {card.assigned_to && <span className="flag claimed">{card.assigned_to}</span>}
        </span>
        <span className={`prio ${card.priority}`}>{card.priority}</span>
        {card.due_date && (
          <span className={overdue ? 'flag overdue' : undefined}>{card.due_date}</span>
        )}
        {card.blocked_by.length > 0 && (
          <span className="flag blocked" title={card.blocked_by.join(', ')}>
            {card.blocked_by.length} blocker{card.blocked_by.length > 1 ? 's' : ''}
          </span>
        )}
        {card.archived && <span className="flag archived">arquivado</span>}
      </div>
      {card.tags.length > 0 && (
        <div className={`card-tags${hasAlert ? ' dim' : ''}`}>
          {visibleTags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
          {hiddenTags > 0 && <span className="tag tag-more">+{hiddenTags}</span>}
        </div>
      )}
    </>
  )
}
