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
// Quanto do fim do log é lido para derivar a fase atual (GET /workflow/agents).
export const WORKFLOW_PHASE_TAIL_BYTES = 64 * 1024

// ── Supervision ──────────────────────────────────────────────────────────────
// Quanto tempo um card pode ficar em `in_progress` sem update antes de contar
// como estagnado (dev agent morto/travado) em kanban_list_escalations.
export const STALE_IN_PROGRESS_MS = 15 * 60 * 1000

// ── HTTP shutdown ─────────────────────────────────────────────────────────────
// Backstop de HttpServer.stop(): conexões abertas (streams SSE incluídos) são
// encerradas ativamente em vez de esperadas — mas se o close() do Node ainda
// assim não resolver a tempo (ex.: socket em estado estranho), o shutdown
// segue adiante depois deste prazo em vez de travar para sempre.
export const HTTP_SHUTDOWN_TIMEOUT_MS = 5_000
