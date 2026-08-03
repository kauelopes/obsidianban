/**
 * Backfill único: reconstrói `role` (wizard/pm/dev/human/system) nas linhas de
 * `token_log` gravadas antes dessa coluna existir — hoje todas caem em
 * 'desconhecido' no /metrics. Idempotente (só toca `role IS NULL`), seguro de
 * rodar mais de uma vez.
 *
 * Sinais usados, do mais forte pro mais fraco:
 * 1. `op` sozinho já resolve PLANNING/WORKFLOW_DEV/WORKFLOW_TRIAGE — essas ops
 *    não existem fora do fluxo do agente correspondente.
 * 2. `actor` começando com "system:" (jobs/reorder automáticos).
 * 3. Para o resto (CREATE/UPDATE/MOVE/REORDER/DELETE), cruza `actor` com os
 *    tokens conhecidos de cada projeto — revogados inclusive, já que
 *    `_meta.json` nunca remove um registro, só marca `revoked_at`.
 *
 * O que sobrar sem resolver fica 'desconhecido' mesmo: actor sem token
 * correspondente em nenhum projeto atual (projeto apagado, ou `_meta.json`
 * editado à mão) — melhor honesto do que forçado num bucket errado.
 *
 * Uso: VAULT_PATH=/caminho/do/vault tsx scripts/backfill-token-log-role.ts
 * Rodar com o servidor PARADO — este script abre o mesmo sqlite direto.
 */
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import { listProjectsSafe } from '../src/vault/layout.js'
import { listAgentTokens, listManagerTokens } from '../src/auth/tokens.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const { db } = await openDatabase(cfg.paths.sqlite)

  const before = (db.prepare(`SELECT COUNT(*) AS n FROM token_log WHERE role IS NULL`).get() as {
    n: number
  }).n
  if (before === 0) {
    console.log('nada a reconstruir — todas as linhas já têm role.')
    db.close()
    return
  }
  console.log(`${before} linha(s) sem role. Reconstruindo por op e por actor conhecido…`)

  db.transaction(() => {
    db.prepare(`UPDATE token_log SET role = 'wizard' WHERE role IS NULL AND op = 'PLANNING'`).run()
    db.prepare(`UPDATE token_log SET role = 'dev' WHERE role IS NULL AND op = 'WORKFLOW_DEV'`).run()
    db.prepare(`UPDATE token_log SET role = 'pm' WHERE role IS NULL AND op = 'WORKFLOW_TRIAGE'`).run()
    db.prepare(`UPDATE token_log SET role = 'system' WHERE role IS NULL AND actor LIKE 'system:%'`).run()
  })()

  const projects = await listProjectsSafe(cfg.paths)
  const agentRole = new Map<string, 'pm' | 'dev'>()
  for (const project of projects) {
    const tokens = await listAgentTokens(cfg.paths, project).catch(() => [])
    for (const t of tokens) agentRole.set(t.actor, t.agent_type)
  }
  const managerActors = new Set(
    (await listManagerTokens(cfg.paths).catch(() => [])).map((t) => t.actor),
  )

  const setRole = db.prepare(`UPDATE token_log SET role = @role WHERE role IS NULL AND actor = @actor`)
  const entries = [
    ...[...agentRole].map(([actor, role]) => ({ actor, role })),
    ...[...managerActors].map((actor) => ({ actor, role: 'human' })),
  ]
  db.transaction(() => {
    for (const e of entries) setRole.run(e)
  })()

  const after = (db.prepare(`SELECT COUNT(*) AS n FROM token_log WHERE role IS NULL`).get() as {
    n: number
  }).n
  console.log(
    `concluído — ${before - after} linha(s) reconstruída(s), ${after} seguem 'desconhecido' ` +
      `(actor sem token correspondente em nenhum projeto atual).`,
  )
  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
