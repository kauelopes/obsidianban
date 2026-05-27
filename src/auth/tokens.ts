import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Paths } from '../config.js'
import {
  loadProjectMeta,
  saveProjectMeta,
  ensureProject,
  type TokenRecord,
} from '../vault/layout.js'

export interface IssuedToken {
  token_id: string
  raw: string
  sha256: string
  actor: string
  created_at: string
}

export interface PublicTokenInfo {
  token_id: string
  actor: string
  created_at: string
  revoked_at: string | null
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function generateToken(): { raw: string; sha256: string; token_id: string } {
  const raw = randomBytes(32).toString('base64url')
  const sha = sha256Hex(raw)
  return { raw, sha256: sha, token_id: sha.slice(0, 12) }
}

// ─── Agent tokens (project-scoped, in _meta.json) ─────────────────────────────

export async function createAgentToken(
  paths: Paths,
  project: string,
  actor: string,
): Promise<IssuedToken> {
  await ensureProject(paths, project)
  const { raw, sha256: sha, token_id } = generateToken()
  const created_at = new Date().toISOString()
  const meta = await loadProjectMeta(paths, project)
  meta.agent_tokens.push({ token_id, sha256: sha, actor, created_at, revoked_at: null })
  await saveProjectMeta(paths, project, meta)
  return { token_id, raw, sha256: sha, actor, created_at }
}

export async function listAgentTokens(
  paths: Paths,
  project: string,
): Promise<PublicTokenInfo[]> {
  const meta = await loadProjectMeta(paths, project)
  return meta.agent_tokens.map(toPublic)
}

export async function revokeAgentToken(
  paths: Paths,
  project: string,
  tokenId: string,
): Promise<boolean> {
  const meta = await loadProjectMeta(paths, project)
  const entry = meta.agent_tokens.find((t) => t.token_id === tokenId)
  if (!entry || entry.revoked_at) return false
  entry.revoked_at = new Date().toISOString()
  await saveProjectMeta(paths, project, meta)
  return true
}

// ─── Manager tokens (unscoped, in .kanban/manager-tokens.json) ────────────────

interface ManagerTokenFile {
  manager_tokens: TokenRecord[]
}

async function loadManagerStore(paths: Paths): Promise<ManagerTokenFile> {
  try {
    const raw = await fs.readFile(paths.managerTokens, 'utf8')
    return JSON.parse(raw) as ManagerTokenFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { manager_tokens: [] }
  }
}

async function saveManagerStore(paths: Paths, store: ManagerTokenFile): Promise<void> {
  await fs.mkdir(path.dirname(paths.managerTokens), { recursive: true })
  await fs.writeFile(paths.managerTokens, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

export async function createManagerToken(paths: Paths, actor: string): Promise<IssuedToken> {
  const store = await loadManagerStore(paths)
  const { raw, sha256: sha, token_id } = generateToken()
  const created_at = new Date().toISOString()
  store.manager_tokens.push({ token_id, sha256: sha, actor, created_at, revoked_at: null })
  await saveManagerStore(paths, store)
  return { token_id, raw, sha256: sha, actor, created_at }
}

export async function listManagerTokens(paths: Paths): Promise<PublicTokenInfo[]> {
  const store = await loadManagerStore(paths)
  return store.manager_tokens.map(toPublic)
}

export async function revokeManagerToken(paths: Paths, tokenId: string): Promise<boolean> {
  const store = await loadManagerStore(paths)
  const entry = store.manager_tokens.find((t) => t.token_id === tokenId)
  if (!entry || entry.revoked_at) return false
  entry.revoked_at = new Date().toISOString()
  await saveManagerStore(paths, store)
  return true
}

// ─── Lookup (used by TokenValidator) ──────────────────────────────────────────

export interface TokenLookupResult {
  sha256: string
  record: TokenRecord
  /** project_id is undefined for manager tokens */
  project_id?: string
}

export async function lookupBySha(
  paths: Paths,
  sha: string,
  knownProjects: string[],
): Promise<TokenLookupResult | null> {
  for (const project of knownProjects) {
    const meta = await loadProjectMeta(paths, project).catch(() => null)
    if (!meta) continue
    const hit = meta.agent_tokens.find((t) => t.sha256 === sha)
    if (hit) return { sha256: sha, record: hit, project_id: project }
  }
  const store = await loadManagerStore(paths)
  const hit = store.manager_tokens.find((t) => t.sha256 === sha)
  if (hit) return { sha256: sha, record: hit }
  return null
}

function toPublic(r: TokenRecord): PublicTokenInfo {
  return {
    token_id: r.token_id,
    actor: r.actor,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  }
}
