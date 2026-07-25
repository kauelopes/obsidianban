import { useState } from 'react'
import { Markdown } from '../markdown/Markdown.js'

/**
 * Markdown editor with preview for a single body zone. Deliberately plain:
 * a textarea plus the same renderer the read view uses, so what you preview
 * is exactly what the card will show.
 */
export function ZoneEditor({
  value,
  onChange,
  disabled,
  placeholder,
  rows = 14,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
  rows?: number
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  return (
    <div className="editor">
      <div className="tabs">
        <button
          type="button"
          className={tab === 'write' ? 'active' : ''}
          onClick={() => setTab('write')}
        >
          escrever
        </button>
        <button
          type="button"
          className={tab === 'preview' ? 'active' : ''}
          onClick={() => setTab('preview')}
        >
          preview
        </button>
      </div>
      {tab === 'write' ? (
        <textarea
          value={value}
          rows={rows}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Markdown>{value}</Markdown>
      )}
    </div>
  )
}

export interface ConflictInfo {
  yourVersion: number
  currentVersion: number
  conflictingFields: string[]
}

/**
 * A 409 is not an error to dismiss — it means someone (an agent, the watcher,
 * another tab) wrote first. The user picks: keep their text against the new
 * version, or drop it and take the server's.
 */
export function ConflictBar({
  conflict,
  onRetry,
  onDiscard,
}: {
  conflict: ConflictInfo
  onRetry: () => void
  onDiscard: () => void
}) {
  return (
    <div className="conflict">
      <p>
        <strong>O card mudou enquanto você editava.</strong> Sua versão era{' '}
        {conflict.yourVersion}; o servidor está em {conflict.currentVersion}
        {conflict.conflictingFields.length > 0 && (
          <> — divergem: {conflict.conflictingFields.join(', ')}</>
        )}
        .
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={onRetry}>
          Reaplicar meu texto sobre a versão nova
        </button>
        <button type="button" onClick={onDiscard}>
          Descartar o meu e recarregar
        </button>
      </div>
    </div>
  )
}
