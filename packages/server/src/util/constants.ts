export const POSITION_GAP = 1000

// ── Activity ─────────────────────────────────────────────────────────────────
// Heurística de sessão: eventos a menos de SESSION_GAP formam uma sessão; uma
// sessão nunca conta menos que SESSION_FLOOR (evento isolado ≠ zero trabalho).
export const SESSION_GAP_MS = 30 * 60 * 1000
export const SESSION_FLOOR_MS = 10 * 60 * 1000
export const GIT_LOG_TIMEOUT_MS = 5_000
export const GIT_CACHE_TTL_MS = 60_000
export const ACTIVITY_DAYS_DEFAULT = 14
export const ACTIVITY_DAYS_MAX = 60

// ── Sprint workflow ──────────────────────────────────────────────────────────
// Chunk máximo por leitura do log de execução (GET /workflow/log).
export const WORKFLOW_LOG_CHUNK_MAX = 64 * 1024
