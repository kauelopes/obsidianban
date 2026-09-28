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

// ── Sprint git automation ────────────────────────────────────────────────────
// Checkout/merge pode demorar mais que um simples `git log`, por isso maior
// que GIT_LOG_TIMEOUT_MS.
export const GIT_LIFECYCLE_TIMEOUT_MS = 15_000

// ── Supervision ──────────────────────────────────────────────────────────────
// Quanto tempo um card pode ficar em `in_progress` sem update antes de contar
// como estagnado (dev agent morto/travado) em kanban_list_escalations.
export const STALE_IN_PROGRESS_MS = 15 * 60 * 1000

// ── Digest semanal ───────────────────────────────────────────────────────────
// Dias em `review` sem resposta a partir dos quais a escalação vira pendência
// da semana. Bem maior que STALE_IN_PROGRESS_MS: ali o sinal é agente morto,
// aqui é humano que não voltou — a escala é de dias, não de minutos.
export const STALE_REVIEW_DAYS = 3
// Teto do scan do audit log por request. Sem índice por timestamp, a leitura é
// linear; o corte troca completude por uma resposta que sempre chega (e diz
// que cortou, via audit_truncated).
export const DIGEST_AUDIT_MAX_LINES = 200_000

// ── Módulos opcionais ────────────────────────────────────────────────────────
// Teto de cards por chamada de listCards na fachada de dados dos módulos — um
// relatório do board inteiro lê tudo, mas nunca sem limite.
export const MODULE_CARDS_MAX = 20_000
// id de módulo: kebab-case curto, vira prefixo de rota e nome de pasta.
export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,39}$/
// LLM dos módulos (MODULES_LLM_TIMEOUT_MS sobrescreve).
export const MODULE_LLM_TIMEOUT_MS = 300_000

// ── Jobs ─────────────────────────────────────────────────────────────────────
// Backstop de JobManager.stop()/dispose(): quanto esperar pelo finalize
// (evento `close` do filho após o SIGKILL) antes de devolver o melhor estado
// conhecido em vez de travar o chamador (ou o shutdown) para sempre.
export const JOB_STOP_WAIT_TIMEOUT_MS_DEFAULT = 15_000

// ── Terminal usage (ingestão de sessões Claude Code fora do board) ──────────
// Pull sob demanda no GET /metrics, não watcher: latência de minutos é ok
// para um dado de contabilidade.
export const TERMINAL_USAGE_TTL_MS = 60_000
// Teto de bytes lidos por RODADA de scan, somando todos os arquivos — evita que
// o backfill inicial (81MB+ num vault com uso real) trave o primeiro
// GET /metrics; o resto completa nos acessos seguintes (offset persistido).
export const TERMINAL_SCAN_MAX_BYTES_PER_ROUND = 8 * 1024 * 1024
// Cache do `git worktree list` por projeto (ligação sessão↔projeto).
export const TERMINAL_PROJECTS_CACHE_TTL_MS = 60_000

// ── HTTP shutdown ─────────────────────────────────────────────────────────────
// Backstop de HttpServer.stop(): conexões abertas (streams SSE incluídos) são
// encerradas ativamente em vez de esperadas — mas se o close() do Node ainda
// assim não resolver a tempo (ex.: socket em estado estranho), o shutdown
// segue adiante depois deste prazo em vez de travar para sempre.
export const HTTP_SHUTDOWN_TIMEOUT_MS = 5_000
