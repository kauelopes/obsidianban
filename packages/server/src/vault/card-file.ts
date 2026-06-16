import { promises as fs } from 'node:fs'
import { parseCardFile, type ParsedCardFile } from '../cards/serialize.js'

export async function readCardFile(filePath: string): Promise<ParsedCardFile> {
  const content = await fs.readFile(filePath, 'utf8')
  return parseCardFile(content)
}

// Reads only the body from a card file; returns '' if the file is missing or unreadable.
export async function readCardBody(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8').then(parseCardFile).then((p) => p.body).catch((_err) => '')
}
