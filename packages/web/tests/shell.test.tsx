import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { KanbanClient } from '../src/api/client.js'
import { Shell } from '../src/App.js'
import { PageHeader } from '../src/ui/PageHeader.js'

const client = {
  planningList: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
} as unknown as KanbanClient

describe('Shell + PageHeader', () => {
  it('topbar carrega só identidade/navegação/estado global; ações de página vão para o page-header', () => {
    const { container } = render(
      <MemoryRouter>
        <Shell client={client} onLogout={() => {}} status={<span data-testid="conn">aberto</span>}>
          <PageHeader>
            <button data-testid="page-action">+ projeto</button>
          </PageHeader>
        </Shell>
      </MemoryRouter>,
    )
    const topbar = container.querySelector('.topbar')!
    const pageHeader = container.querySelector('.page-header')!
    expect(topbar.querySelector('[data-testid="page-action"]')).toBeNull()
    expect(pageHeader.querySelector('[data-testid="page-action"]')).toBeTruthy()
    expect(topbar.querySelector('[data-testid="conn"]')).toBeTruthy()
  })
})
