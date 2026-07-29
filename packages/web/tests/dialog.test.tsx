import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog } from '../src/ui/Dialog.js'

function Harness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        abrir
      </button>
      {open && (
        <Dialog title="Título do diálogo" onClose={() => setOpen(false)}>
          <input data-testid="first" />
          <button data-testid="last">ok</button>
        </Dialog>
      )}
    </>
  )
}

describe('Dialog', () => {
  it('move o foco para dentro do dialog ao abrir', () => {
    render(<Harness />)
    expect(document.activeElement).toBe(screen.getByTestId('first'))
  })

  it('Tab no último elemento cicla para o primeiro', () => {
    const { container } = render(<Harness />)
    const dialog = container.querySelector('.dialog') as HTMLElement
    screen.getByTestId('last').focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('first'))
  })

  it('Shift+Tab no primeiro elemento cicla para o último', () => {
    const { container } = render(<Harness />)
    const dialog = container.querySelector('.dialog') as HTMLElement
    screen.getByTestId('first').focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('last'))
  })

  it('fechar devolve o foco ao elemento que abriu o dialog', () => {
    render(<Harness initiallyOpen={false} />)
    const trigger = screen.getByTestId('trigger')
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByLabelText('fechar'))
    expect(document.activeElement).toBe(trigger)
  })

  it('aria-labelledby do dialog aponta para o título', () => {
    const { container } = render(<Harness />)
    const dialog = container.querySelector('.dialog') as HTMLElement
    const titleId = dialog.getAttribute('aria-labelledby')
    expect(titleId).toBeTruthy()
    expect(document.getElementById(titleId!)?.textContent).toBe('Título do diálogo')
  })
})
