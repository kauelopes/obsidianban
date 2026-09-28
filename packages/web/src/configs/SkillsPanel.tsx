import { useEffect, useMemo, useState } from 'react'
import type { SkillFileEntry } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { ZoneEditor } from '../card/ZoneEditor.js'

/**
 * Edita a fonte única de skills (.claude/skills/ no monorepo) — o que
 * workflow-readiness replica para o target_repo de cada projeto na próxima
 * checagem de prontidão. Não edita a cópia dentro de um projeto: edita a
 * origem que todos herdam.
 */
export function SkillsPanel({ client }: { client: KanbanClient }) {
  const [files, setFiles] = useState<SkillFileEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    client.listSkillFiles().then((res) => {
      if (cancelled) return
      if (res.ok) setFiles(res.data.files)
      else setListError(res.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoadingDoc(true)
    setDocError(null)
    client.getSkillFile(selected).then((res) => {
      if (cancelled) return
      setLoadingDoc(false)
      if (res.ok) {
        setContent(res.data.content)
        setDraft(res.data.content)
      } else {
        setContent(null)
        // Sem isto o draft continuaria com o texto do arquivo anterior, que
        // um "salvar" seguinte gravaria neste path.
        setDraft('')
        setDocError(res.error.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [client, selected])

  const grouped = useMemo(() => {
    const map = new Map<string, SkillFileEntry[]>()
    for (const f of files ?? []) {
      const list = map.get(f.skill) ?? []
      list.push(f)
      map.set(f.skill, list)
    }
    return [...map.entries()]
  }, [files])

  const dirty = content !== null && draft !== content

  function select(path: string) {
    if (path === selected) return
    // Trocar de arquivo recarrega content/draft — sem o aviso, a edição não
    // salva some sem deixar rastro (o pill "não salvo" é a única pista).
    if (dirty && !window.confirm('Há alterações não salvas neste arquivo. Descartar?')) return
    setSelected(path)
  }

  async function save() {
    if (!selected) return
    setSaving(true)
    setSaveError(null)
    const res = await client.writeSkillFile(selected, draft)
    setSaving(false)
    if (res.ok) {
      setContent(res.data.content)
      setDraft(res.data.content)
    } else {
      setSaveError(res.error.message)
    }
  }

  if (listError) return <p className="banner">{listError}</p>
  if (!files) return <p className="muted">carregando…</p>

  return (
    <div className="skills-layout">
      <nav className="skills-files" aria-label="Arquivos de skill">
        {grouped.map(([skill, entries]) => (
          <div key={skill} className="skills-group">
            <div className="skills-group-label">{skill}</div>
            {entries.map((f) => (
              <button
                key={f.path}
                type="button"
                className={selected === f.path ? 'active' : undefined}
                onClick={() => select(f.path)}
              >
                {f.path.slice(skill.length + 1)}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="skills-editor">
        {!selected && <p className="muted">Selecione um arquivo para editar.</p>}
        {selected && loadingDoc && <p className="muted">carregando…</p>}
        {selected && docError && <p className="banner">{docError}</p>}
        {selected && !loadingDoc && content !== null && (
          <>
            <div className="skills-editor-head">
              <code>{selected}</code>
              {dirty && <span className="pill">não salvo</span>}
            </div>
            <ZoneEditor value={draft} onChange={setDraft} disabled={saving} rows={22} />
            {saveError && <p className="banner">{saveError}</p>}
            <div className="skills-editor-actions">
              <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? 'salvando…' : 'salvar'}
              </button>
              <button type="button" disabled={!dirty || saving} onClick={() => setDraft(content)}>
                reverter
              </button>
            </div>
            <p className="field-help">
              Isto edita a fonte única — a próxima checagem de prontidão do workflow replica para o repositório de
              cada projeto.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
