import { Client } from 'drive9'
import type { BatchStatResult, FileInfo, StatResult, WriteOptions } from 'drive9'

export interface Drive9Client {
  writeWithRevision(path: string, data: Uint8Array, options?: number | WriteOptions): Promise<number>
  read(path: string): Promise<Uint8Array>
  readAt(path: string, offset: number, length: number): Promise<Uint8Array>
  readStream(path: string): Promise<ReadableStream<Uint8Array>>
  list(path: string): Promise<FileInfo[]>
  batchStat(paths: string[]): Promise<BatchStatResult[]>
  stat(path: string): Promise<StatResult>
  delete(path: string): Promise<void>
}

export type Drive9ClientFactory = (baseUrl: string | undefined, apiKey: string | undefined) => Drive9Client

export const defaultClientFactory: Drive9ClientFactory = (baseUrl, apiKey) => new Client(baseUrl, apiKey)

export function statusCodeOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object' || !('statusCode' in error)) return undefined
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

export function isConflict(error: unknown): boolean {
  return statusCodeOf(error) === 409 || (error instanceof Error && error.name === 'ConflictError')
}
