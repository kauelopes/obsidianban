import { describe, it, expect } from 'vitest'
import { parseSseBlock, feedSseChunk } from '../src/mcp/sse-parser'

describe('parseSseBlock', () => {
  it('parseia um bloco SSE completo', () => {
    const block = 'id: 1\nevent: card_moved\ndata: {"id":"abc"}'
    expect(parseSseBlock(block)).toEqual({ id: 1, type: 'card_moved', data: { id: 'abc' } })
  })

  it('retorna null se não tem campo event', () => {
    expect(parseSseBlock('id: 1\ndata: {}')).toBeNull()
  })

  it('retorna null se não tem campo id', () => {
    expect(parseSseBlock('event: ping\ndata: {}')).toBeNull()
  })

  it('ignora id não numérico', () => {
    expect(parseSseBlock('id: abc\nevent: ping\ndata: {}')).toBeNull()
  })

  it('ignora id infinito', () => {
    expect(parseSseBlock('id: Infinity\nevent: ping\ndata: {}')).toBeNull()
  })

  it('retorna data: null quando JSON é inválido', () => {
    expect(parseSseBlock('id: 1\nevent: ping\ndata: not-json')).toEqual({
      id: 1,
      type: 'ping',
      data: null,
    })
  })

  it('retorna data: null quando campo data está ausente', () => {
    expect(parseSseBlock('id: 1\nevent: ping')).toEqual({ id: 1, type: 'ping', data: null })
  })

  it('aceita data como array JSON', () => {
    const result = parseSseBlock('id: 5\nevent: batch\ndata: [1,2,3]')
    expect(result?.data).toEqual([1, 2, 3])
  })

  it('aceita id 0', () => {
    expect(parseSseBlock('id: 0\nevent: ping\ndata: {}')).toMatchObject({ id: 0 })
  })
})

describe('feedSseChunk', () => {
  it('acumula chunk incompleto no buffer sem emitir frames', () => {
    const { buf, frames } = feedSseChunk('', 'id: 1\nevent: ping')
    expect(buf).toBe('id: 1\nevent: ping')
    expect(frames).toHaveLength(0)
  })

  it('emite frame ao encontrar \\n\\n', () => {
    const { buf, frames } = feedSseChunk('', 'id: 1\nevent: ping\ndata: {}\n\n')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 1, type: 'ping' })
    expect(buf).toBe('')
  })

  it('emite múltiplos frames em um único chunk', () => {
    const chunk =
      'id: 1\nevent: a\ndata: {"x":1}\n\nid: 2\nevent: b\ndata: {"x":2}\n\n'
    const { frames } = feedSseChunk('', chunk)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ id: 1, type: 'a', data: { x: 1 } })
    expect(frames[1]).toMatchObject({ id: 2, type: 'b', data: { x: 2 } })
  })

  it('combina buffer anterior com novo chunk para completar frame', () => {
    const { buf: buf1 } = feedSseChunk('', 'id: 1\nevent: ping')
    const { frames, buf: buf2 } = feedSseChunk(buf1, '\ndata: {}\n\n')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 1, type: 'ping' })
    expect(buf2).toBe('')
  })

  it('mantém resto no buffer quando chunk tem frame incompleto no final', () => {
    const chunk = 'id: 1\nevent: a\ndata: {}\n\nid: 2\nevent: b'
    const { frames, buf } = feedSseChunk('', chunk)
    expect(frames).toHaveLength(1)
    expect(buf).toBe('id: 2\nevent: b')
  })

  it('descarta blocos sem type ou id válido silenciosamente', () => {
    const { frames } = feedSseChunk('', 'data: {}\n\n')
    expect(frames).toHaveLength(0)
  })

  it('não muta o buffer original passado', () => {
    const original = 'id: 1\nevent: ping'
    feedSseChunk(original, '\ndata: {}\n\n')
    expect(original).toBe('id: 1\nevent: ping')
  })
})
