import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TokenClaims, WorkflowReadinessResult } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import type { AdminService } from '../services/admin.js'
import type { SprintService } from '../services/sprint.js'
import type { CardService } from '../services/card.js'
import type { EpicService } from '../services/epic.js'
import type { PlanningSession } from './session.js'
import type { FinalStructure } from './structure-schema.js'
import { projectDir } from '../vault/layout.js'
import { logger } from '../util/logger.js'

const BULK_BATCH = 100

export interface MaterializeDeps {
  paths: Paths
  admin: AdminService
  sprints: SprintService
  cards: CardService
  epics: EpicService
  /** Persiste a sessão após cada fase — é o checkpoint da retomada. */
  saveSession(session: PlanningSession): Promise<void>
}

export interface MaterializeResult {
  project: string
  /** Token pm inicial — presente só na primeira passada; null na retomada. */
  token: string | null
  token_id: string | null
  workflow_readiness?: WorkflowReadinessResult
  token_hint?: string
  epics: number
  sprints: number
  cards_created: number
  cards_failed: Array<{ sprint: string; index: number; error: string }>
  goals: number
  kad_files: string[]
  /** null = sem target_repo; false = cópia falhou (aviso, não erro). */
  repo_copy_ok: boolean | null
}

export type Materializer = (
  session: PlanningSession,
  structure: FinalStructure,
  claims: TokenClaims,
) => Promise<MaterializeResult>

/**
 * Materializa a estrutura final no board e grava o KAD. Cada fase registra um
 * checkpoint na sessão (persistido via saveSession); re-chamar após uma falha
 * retoma da fase pendente sem duplicar nada — criações já feitas são puladas
 * pelo checkpoint, não por heurística.
 */
export function createMaterializer(deps: MaterializeDeps): Materializer {
  return async (session, structure, claims) => {
    const project = structure.project.name
    const targetRepo = structure.project.target_repo ?? session.target_repo ?? undefined
    const cp = (session.materialization ??= {})
    const save = () => deps.saveSession(session)

    // 1. Projeto (minta o token pm — aparece uma única vez, nunca persiste)
    let token: string | null = null
    let tokenId: string | null = null
    let readiness: WorkflowReadinessResult | undefined
    if (!cp.project_created) {
      const created = await deps.admin.createProject(
        { project, actor: claims.actor, ...(targetRepo ? { target_repo: targetRepo } : {}) },
        claims,
      )
      token = created.token
      tokenId = created.token_id
      readiness = created.workflow_readiness
      cp.project_created = true
      await save()
    }

    // 2. Épicos
    cp.epics ??= {}
    for (const epic of structure.epics) {
      if (cp.epics[epic.name]) continue
      const { epic: created } = await deps.epics.createEpic(
        { project, name: epic.name, objective: epic.objective },
        claims,
      )
      cp.epics[epic.name] = created.id
      await save()
    }

    // 3. Sprints (em planning — ativar é decisão humana posterior)
    cp.sprints ??= {}
    for (const epic of structure.epics) {
      for (const sprint of epic.sprints) {
        const key = `${epic.name}/${sprint.name}`
        if (cp.sprints[key]) continue
        const created = await deps.sprints.createSprint(
          { project, name: sprint.name, goal: sprint.goal },
          claims,
        )
        cp.sprints[key] = created.id
        await save()
      }
      // Vínculo épico → sprints: substituição total a partir do checkpoint,
      // idempotente na retomada.
      await deps.epics.updateEpic(
        {
          project,
          id: cp.epics[epic.name]!,
          sprint_ids: epic.sprints.map((s) => cp.sprints![`${epic.name}/${s.name}`]!),
        },
        claims,
      )
    }

    // 4. Cards por sprint, em lotes ≤100 — falha por card vira relatório
    cp.cards ??= {}
    let cardsCreated = 0
    const cardsFailed: MaterializeResult['cards_failed'] = []
    for (const epic of structure.epics) {
      for (const sprint of epic.sprints) {
        const sprintId = cp.sprints[`${epic.name}/${sprint.name}`]!
        const already = cp.cards[sprintId] ?? 0
        cardsCreated += already
        const epicTag = `epic:${slug(epic.name)}`
        for (let i = already; i < sprint.tasks.length; i += BULK_BATCH) {
          const batch = sprint.tasks.slice(i, i + BULK_BATCH)
          const res = await deps.cards.bulkCreate(
            {
              project,
              sprint_id: sprintId,
              cards: batch.map((t) => ({
                title: t.title,
                type: t.type,
                ...(t.body ? { body: t.body } : {}),
                ...(t.priority ? { priority: t.priority } : {}),
                tags: [...(t.tags ?? []), epicTag],
              })),
              input_tokens: 0,
              output_tokens: 0,
            },
            claims,
          )
          cardsCreated += res.created.length
          for (const f of res.failed) {
            cardsFailed.push({ sprint: sprint.name, index: i + f.index, error: f.error })
          }
          cp.cards[sprintId] = i + batch.length
          await save()
        }
      }
    }

    // 5. Milestones marcados como metas
    if (structure.goals && !cp.goals_done) {
      for (const g of structure.goals) {
        await deps.admin.setGoal(
          {
            project,
            title: g.title,
            ...(g.target_date !== undefined ? { target_date: g.target_date } : {}),
            ...(g.notes ? { notes: g.notes } : {}),
          },
          claims,
        )
      }
      cp.goals_done = true
      await save()
    }

    // 6. KAD no vault — kanban-data/<project>/kad/*.md (o watcher ignora
    //    subpastas; ver isCardFile no FileWatcher)
    const kadDir = path.join(projectDir(deps.paths, project), 'kad')
    await fs.mkdir(kadDir, { recursive: true })
    const kadFiles: string[] = []
    for (const [doc, md] of Object.entries(session.kad)) {
      const file = path.join(kadDir, `${doc}.md`)
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, md, 'utf8')
      await fs.rename(tmp, file)
      kadFiles.push(`kad/${doc}.md`)
    }
    cp.kad_written = true
    await save()

    // 7. Cópia para o repo — falha vira aviso; o vault é a fonte da verdade
    let repoCopyOk: boolean | null = null
    if (targetRepo) {
      try {
        const dest = path.join(targetRepo, 'docs', 'kad')
        await fs.mkdir(dest, { recursive: true })
        for (const [doc, md] of Object.entries(session.kad)) {
          await fs.writeFile(path.join(dest, `${doc}.md`), md, 'utf8')
        }
        repoCopyOk = true
      } catch (err) {
        logger.warn({ err, targetRepo }, 'planning: failed to copy KAD to target_repo')
        repoCopyOk = false
      }
      cp.repo_copied = repoCopyOk === true
      await save()
    }

    return {
      project,
      token,
      token_id: tokenId,
      ...(readiness ? { workflow_readiness: readiness } : {}),
      ...(token === null
        ? { token_hint: 'token pm mintado numa passada anterior — gere outro com kanban_create_agent_token' }
        : {}),
      epics: structure.epics.length,
      sprints: Object.keys(cp.sprints).length,
      cards_created: cardsCreated,
      cards_failed: cardsFailed,
      goals: structure.goals?.length ?? 0,
      kad_files: kadFiles,
      repo_copy_ok: repoCopyOk,
    }
  }
}

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}
