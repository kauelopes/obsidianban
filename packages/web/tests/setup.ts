import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

/**
 * jsdom não implementa matchMedia, e o hook de tema chama addEventListener nele
 * no primeiro render. Sem este stub qualquer teste que monte a casca explode
 * antes de chegar na asserção.
 *
 * Retorna matches:false, ou seja: tema escuro, que é o default da aplicação.
 */
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

/**
 * EventSource também não existe no jsdom. O board assina /events no mount, e
 * sem isto o construtor lança. É um duplo inerte: os testes que exercitam SSE
 * de verdade injetam o próprio.
 */
if (!('EventSource' in window)) {
  class InertEventSource {
    static readonly CLOSED = 2
    readyState = 0
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  Object.defineProperty(window, 'EventSource', { writable: true, value: InertEventSource })
}
