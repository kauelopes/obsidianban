import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLogSlice } from '../../src/util/log-file.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-file-test-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readLogSlice', () => {
  it('lê do offset 0 até o fim quando maxBytes cobre tudo', async () => {
    const file = path.join(dir, 'a.log')
    await fs.writeFile(file, 'hello world', 'utf8')

    const slice = await readLogSlice(file, 0)
    expect(slice).toEqual({ size: 11, data: 'hello world' })
  })

  it('lê a partir de um offset no meio do arquivo', async () => {
    const file = path.join(dir, 'b.log')
    await fs.writeFile(file, 'hello world', 'utf8')

    const slice = await readLogSlice(file, 6)
    expect(slice).toEqual({ size: 11, data: 'world' })
  })

  it('offset além do fim do arquivo devolve string vazia e size = fim do arquivo', async () => {
    const file = path.join(dir, 'c.log')
    await fs.writeFile(file, 'hello', 'utf8')

    const slice = await readLogSlice(file, 999)
    expect(slice).toEqual({ size: 5, data: '' })
  })

  it('respeita maxBytes, truncando o retorno a um chunk', async () => {
    const file = path.join(dir, 'd.log')
    await fs.writeFile(file, 'abcdefghij', 'utf8')

    const slice = await readLogSlice(file, 0, 4)
    expect(slice).toEqual({ size: 4, data: 'abcd' })
  })

  it('arquivo inexistente devolve null', async () => {
    const slice = await readLogSlice(path.join(dir, 'nope.log'), 0)
    expect(slice).toBeNull()
  })

  it('offset negativo é tratado como 0', async () => {
    const file = path.join(dir, 'e.log')
    await fs.writeFile(file, 'hello', 'utf8')

    const slice = await readLogSlice(file, -5)
    expect(slice).toEqual({ size: 5, data: 'hello' })
  })
})
