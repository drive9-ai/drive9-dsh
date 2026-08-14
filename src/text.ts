import { TextDecoder } from 'node:util'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditRequest } from '@deepseek-ai/dsh-fs'

export const BINARY_SAMPLE_BYTES = 8192

export function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

export function decodeText(bytes: Uint8Array, displayPath: string, verb: 'read' | 'edit' = 'read'): string {
  if (bytes.includes(0)) throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

export async function* decodeTextStream(
  stream: ReadableStream<Uint8Array>,
  displayPath: string,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      throwIfAborted(signal, 'read')
      const result = await reader.read()
      if (result.done) break
      if (result.value.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
      try {
        const text = decoder.decode(result.value, { stream: true })
        if (text.length > 0) yield text
      } catch (error: unknown) {
        throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
      }
    }
    try {
      const tail = decoder.decode()
      if (tail.length > 0) yield tail
    } catch (error: unknown) {
      throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
    }
  } finally {
    reader.releaseLock()
  }
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function lineEndingStyle(text: string): 'lf' | 'crlf' {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? 'crlf' : 'lf'
}

function replaceEvery(input: string, search: string, replacement: string): string {
  return input.split(search).join(replacement)
}

export function applyLiteralEdit(
  raw: string,
  edit: FsEditRequest,
  displayPath: string,
): { before: string; after: string; storage: string } {
  const oldString = normalizeLineEndings(edit.oldString)
  if (oldString.length === 0) throw new FsError('old_string must be non-empty', 'FS_EDIT_NOT_FOUND')
  const before = normalizeLineEndings(raw)
  const replacement = normalizeLineEndings(edit.newString)
  let matches = 0
  let cursor = 0
  while (true) {
    const found = before.indexOf(oldString, cursor)
    if (found < 0) break
    matches += 1
    cursor = found + oldString.length
  }
  if (matches === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (!edit.replaceAll && matches > 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string is ambiguous`, 'FS_AMBIGUOUS_EDIT')
  }
  const after = edit.replaceAll
    ? replaceEvery(before, oldString, replacement)
    : before.replace(oldString, replacement)
  const storage = lineEndingStyle(raw) === 'crlf' ? after.replaceAll('\n', '\r\n') : after
  return { before, after, storage }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\uFFFD$/u, '')
}
