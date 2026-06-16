import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { SSEEventBus } from '../../src/server/sse.js'
import type { SSEEvent } from '../../src/types.js'

function makeMockRes() {
  return { write: vi.fn(), end: vi.fn(), on: vi.fn() } as unknown as ServerResponse
}

function makeEvent(type: SSEEvent['type'] = 'CARD_CREATED'): SSEEvent {
  return { type, payload: { id: 'card-test001' } } as SSEEvent
}

let bus: SSEEventBus

beforeEach(() => {
  bus = new SSEEventBus()
})

describe('SSEEventBus.size', () => {
  it('is 0 with no subscribers', () => {
    expect(bus.size()).toBe(0)
  })

  it('increments when a client subscribes', () => {
    bus.subscribe(makeMockRes(), null)
    expect(bus.size()).toBe(1)
  })

  it('decrements when unsubscribe is called', () => {
    const unsub = bus.subscribe(makeMockRes(), null)
    unsub()
    expect(bus.size()).toBe(0)
  })

  it('tracks multiple clients independently', () => {
    const unsub1 = bus.subscribe(makeMockRes(), null)
    bus.subscribe(makeMockRes(), null)
    bus.subscribe(makeMockRes(), null)
    unsub1()
    expect(bus.size()).toBe(2)
  })
})

describe('SSEEventBus.emit', () => {
  it('emitting to 0 subscribers does not throw', () => {
    expect(() => bus.emit(makeEvent())).not.toThrow()
  })

  it('sends a correctly formatted SSE frame to a subscriber', () => {
    const res = makeMockRes()
    bus.subscribe(res, null)
    bus.emit(makeEvent('CARD_CREATED'))

    expect(vi.mocked(res.write)).toHaveBeenCalledOnce()
    const frame = vi.mocked(res.write).mock.calls[0]![0] as string
    expect(frame).toMatch(/^id: \d+\nevent: CARD_CREATED\ndata: .+\n\n$/)
  })

  it('sends to all N subscribers', () => {
    const clients = [makeMockRes(), makeMockRes(), makeMockRes()]
    clients.forEach((r) => bus.subscribe(r, null))
    bus.emit(makeEvent())
    clients.forEach((r) => expect(vi.mocked(r.write)).toHaveBeenCalledOnce())
  })

  it('swallows write errors (broken pipe)', () => {
    const res = makeMockRes()
    vi.mocked(res.write).mockImplementation(() => {
      throw new Error('broken pipe')
    })
    bus.subscribe(res, null)
    expect(() => bus.emit(makeEvent())).not.toThrow()
  })

  it('event id increments monotonically', () => {
    const res = makeMockRes()
    bus.subscribe(res, null)
    bus.emit(makeEvent())
    bus.emit(makeEvent())
    bus.emit(makeEvent())

    const ids = vi
      .mocked(res.write)
      .mock.calls.map((call) => Number((call[0] as string).match(/^id: (\d+)/)![1]))
    expect(ids).toEqual([1, 2, 3])
  })
})

describe('SSEEventBus.subscribe — history replay', () => {
  it('subscribe with null lastEventId does not replay history', () => {
    bus.emit(makeEvent())
    bus.emit(makeEvent())
    const res = makeMockRes()
    bus.subscribe(res, null)
    expect(vi.mocked(res.write)).not.toHaveBeenCalled()
  })

  it('subscribe with lastEventId = 0 replays all history', () => {
    bus.emit(makeEvent())
    bus.emit(makeEvent())
    bus.emit(makeEvent())
    const res = makeMockRes()
    bus.subscribe(res, 0)
    expect(vi.mocked(res.write)).toHaveBeenCalledTimes(3)
  })

  it('subscribe with lastEventId = 2 replays only events after id 2', () => {
    bus.emit(makeEvent()) // id 1
    bus.emit(makeEvent()) // id 2
    bus.emit(makeEvent()) // id 3
    const res = makeMockRes()
    bus.subscribe(res, 2)
    expect(vi.mocked(res.write)).toHaveBeenCalledTimes(1)
    const frame = vi.mocked(res.write).mock.calls[0]![0] as string
    expect(frame).toMatch(/^id: 3\n/)
  })

  it('subscribe with stale lastEventId (before buffer start) replays only what is available', () => {
    // Emit 101 events to trigger rollover — oldest (id=1) is dropped
    for (let i = 0; i < 101; i++) bus.emit(makeEvent())
    const res = makeMockRes()
    // lastEventId=0 means "replay everything", but history only has 100 events (ids 2-101)
    bus.subscribe(res, 0)
    expect(vi.mocked(res.write)).toHaveBeenCalledTimes(100)
  })

  it('history rolls over at 100 events and drops the oldest', () => {
    for (let i = 0; i < 101; i++) bus.emit(makeEvent())
    // Access history via the bus — subscribe with lastEventId=0 gives us count
    const res = makeMockRes()
    bus.subscribe(res, 0)
    const firstFrame = vi.mocked(res.write).mock.calls[0]![0] as string
    // Oldest event in history should be id=2 (id=1 was dropped)
    expect(firstFrame).toMatch(/^id: 2\n/)
  })
})

describe('SSEEventBus.subscribe — unsubscribe', () => {
  it('after unsubscribing, later emits do not reach the client', () => {
    const res = makeMockRes()
    const unsub = bus.subscribe(res, null)
    unsub()
    bus.emit(makeEvent())
    expect(vi.mocked(res.write)).not.toHaveBeenCalled()
  })
})
