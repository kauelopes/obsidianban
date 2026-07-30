import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StepTaskList } from '../src/plan/screens.js'

describe('StepTaskList', () => {
  const basePayload = {
    tasks: [
      { id: 't-0', title: 'Tarefa 1', type: 'task' as const, priority: 'medium' as const },
      { id: 't-1', title: 'Tarefa 2', type: 'bug' as const, priority: 'high' as const, tags: ['x'] },
    ],
  }

  it('edita título, remove uma tarefa e envia o array sem os ids sintéticos', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)

    fireEvent.change(screen.getAllByLabelText('título da tarefa')[0]!, {
      target: { value: 'Tarefa 1 editada' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'remover Tarefa 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))

    expect(onSubmit).toHaveBeenCalledWith({
      tasks: [{ title: 'Tarefa 1 editada', type: 'task', priority: 'medium' }],
    })
  })

  it('adicionar tarefa insere uma linha em branco (type task, priority medium)', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ adicionar tarefa' }))
    expect(screen.getAllByLabelText('título da tarefa')).toHaveLength(3)
  })

  it('confirmar fica desabilitado com título vazio ou lista vazia', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ adicionar tarefa' }))
    expect(
      (screen.getByRole('button', { name: 'Confirmar e continuar' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('edita tipo e prioridade via selects', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    const typeSelects = screen.getAllByLabelText('Tipo')
    const prioritySelects = screen.getAllByLabelText('Prioridade')
    fireEvent.change(typeSelects[0]!, { target: { value: 'bug' } })
    fireEvent.change(prioritySelects[0]!, { target: { value: 'critical' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({
      tasks: [
        { title: 'Tarefa 1', type: 'bug', priority: 'critical' },
        { title: 'Tarefa 2', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
  })

  it('adiciona uma tag a uma tarefa', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    const tagInputs = screen.getAllByPlaceholderText('nova tag + Enter')
    fireEvent.change(tagInputs[0]!, { target: { value: 'nova' } })
    fireEvent.keyDown(tagInputs[0]!, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({
      tasks: [
        { title: 'Tarefa 1', type: 'task', priority: 'medium', tags: ['nova'] },
        { title: 'Tarefa 2', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
  })

  it('renderiza a caixa de correção e chama onRefine', () => {
    const onRefine = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={vi.fn()} onRefine={onRefine} />)
    fireEvent.change(screen.getByLabelText('pedir correção'), { target: { value: 'tarefas muito vagas' } })
    fireEvent.click(screen.getByRole('button', { name: 'corrigir' }))
    expect(onRefine).toHaveBeenCalledWith('tarefas muito vagas')
  })
})
