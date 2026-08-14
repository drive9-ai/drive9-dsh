import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { posix } from 'node:path'
import type { BatchStatResult, FileInfo, StatResult, WriteOptions } from 'drive9'
import type { Drive9Client } from '../src/client.js'

export class FakeStatusError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = statusCode === 409 ? 'ConflictError' : 'StatusError'
  }
}

interface NodeRecord {
  data?: Uint8Array
  isDir: boolean
  revision: number
  mode?: number
}

export interface FakeDrive9Options {
  mountRoot?: string
  remoteRoot?: string
  mirrorWrites?: boolean
  mirrorDeletes?: boolean
}

export class FakeDrive9Client implements Drive9Client {
  readonly nodes = new Map<string, NodeRecord>()
  readonly batchStatCalls: string[][] = []
  beforeWrite: ((path: string, data: Uint8Array, expectedRevision: number | undefined) => void | Promise<void>) | undefined
  afterWrite: ((path: string, data: Uint8Array, revision: number) => void | Promise<void>) | undefined
  beforeRead: ((path: string) => void | Promise<void>) | undefined
  private revision = 1
  private readonly mountRoot: string | undefined
  private readonly remoteRoot: string | undefined
  private readonly mirrorWrites: boolean
  private readonly mirrorDeletes: boolean

  constructor(options: FakeDrive9Options = {}) {
    this.mountRoot = options.mountRoot
    this.remoteRoot = options.remoteRoot
    this.mirrorWrites = options.mirrorWrites ?? true
    this.mirrorDeletes = options.mirrorDeletes ?? true
    this.mkdirRecord('/')
    if (options.remoteRoot !== undefined) this.mkdirRecord(options.remoteRoot)
  }

  mkdirRecord(path: string): void {
    const normalized = posix.normalize(path)
    if (normalized !== '/') this.mkdirRecord(posix.dirname(normalized))
    if (!this.nodes.has(normalized)) this.nodes.set(normalized, { isDir: true, revision: this.revision++ })
  }

  async writeWithRevision(path: string, data: Uint8Array, options?: number | WriteOptions): Promise<number> {
    const normalized = posix.normalize(path)
    const expectedRevision = typeof options === 'number' ? options : options?.expectedRevision
    await this.beforeWrite?.(normalized, data, expectedRevision)
    await this.refreshFromMount(normalized)
    const existing = this.nodes.get(normalized)
    if (existing?.isDir) throw new FakeStatusError('not a file', 409)
    if (expectedRevision !== undefined && (existing?.revision ?? 0) !== expectedRevision) {
      throw new FakeStatusError('revision conflict', 409)
    }
    this.mkdirRecord(posix.dirname(normalized))
    const revision = this.revision++
    this.nodes.set(normalized, { data: Uint8Array.from(data), isDir: false, revision })
    await this.writeMount(normalized, data)
    await this.afterWrite?.(normalized, data, revision)
    return revision
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = posix.normalize(path)
    await this.beforeRead?.(normalized)
    await this.refreshFromMount(normalized)
    const node = this.nodes.get(normalized)
    if (node === undefined) throw new FakeStatusError('not found', 404)
    if (node.isDir || node.data === undefined) throw new FakeStatusError('is directory', 400)
    return Uint8Array.from(node.data)
  }

  async readAt(path: string, offset: number, length: number): Promise<Uint8Array> {
    const data = await this.read(path)
    return data.slice(offset, offset + length)
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const data = await this.read(path)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.slice(0, Math.max(1, Math.floor(data.length / 2))))
        controller.enqueue(data.slice(Math.max(1, Math.floor(data.length / 2))))
        controller.close()
      },
    })
  }

  async list(path: string): Promise<FileInfo[]> {
    const normalized = posix.normalize(path)
    const parent = this.nodes.get(normalized)
    if (parent === undefined) throw new FakeStatusError('not found', 404)
    if (!parent.isDir) throw new FakeStatusError('not a directory', 400)
    const names = new Map<string, NodeRecord>()
    for (const [candidate, node] of this.nodes) {
      if (candidate === normalized || posix.dirname(candidate) !== normalized) continue
      names.set(posix.basename(candidate), node)
    }
    return [...names].map(([name, node]) => ({
      name,
      size: node.data?.byteLength ?? 0,
      isDir: node.isDir,
      ...(node.mode !== undefined ? { mode: node.mode, hasMode: true } : {}),
    }))
  }

  async batchStat(paths: string[]): Promise<BatchStatResult[]> {
    this.batchStatCalls.push([...paths])
    return Promise.all(paths.map(async (path) => {
      try {
        const result = await this.stat(path)
        return {
          path,
          status: 200,
          size: result.size,
          isDir: result.isDir,
          revision: result.revision,
          ...(result.mode !== undefined ? { mode: result.mode, hasMode: true } : {}),
        }
      } catch (error: unknown) {
        return { path, status: error instanceof FakeStatusError ? error.statusCode : 500, isDir: false }
      }
    }))
  }

  async stat(path: string): Promise<StatResult> {
    const normalized = posix.normalize(path)
    await this.refreshFromMount(normalized)
    const node = this.nodes.get(normalized)
    if (node === undefined) throw new FakeStatusError('not found', 404)
    return {
      size: node.data?.byteLength ?? 0,
      isDir: node.isDir,
      revision: node.revision,
      ...(node.mode !== undefined ? { mode: node.mode, hasMode: true } : {}),
    }
  }

  async delete(path: string): Promise<void> {
    const normalized = posix.normalize(path)
    if (!this.nodes.delete(normalized)) throw new FakeStatusError('not found', 404)
    const local = this.localPath(normalized)
    if (local !== undefined && this.mirrorDeletes) await rm(local, { force: true, recursive: true })
  }

  setFile(path: string, data: Uint8Array | string, mode?: number): number {
    const normalized = posix.normalize(path)
    this.mkdirRecord(posix.dirname(normalized))
    const revision = this.revision++
    this.nodes.set(normalized, {
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : Uint8Array.from(data),
      isDir: false,
      revision,
      ...(mode !== undefined ? { mode } : {}),
    })
    return revision
  }

  getFile(path: string): Uint8Array | undefined {
    return this.nodes.get(posix.normalize(path))?.data
  }

  private localPath(remotePath: string): string | undefined {
    if (this.mountRoot === undefined || this.remoteRoot === undefined) return undefined
    const rel = posix.relative(this.remoteRoot, remotePath)
    if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return undefined
    return rel === '' ? this.mountRoot : join(this.mountRoot, ...rel.split('/'))
  }

  private async writeMount(remotePath: string, data: Uint8Array): Promise<void> {
    if (!this.mirrorWrites) return
    const local = this.localPath(remotePath)
    if (local === undefined) return
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, data)
  }

  private async refreshFromMount(remotePath: string): Promise<void> {
    const local = this.localPath(remotePath)
    if (local === undefined) return
    try {
      const info = await stat(local)
      if (info.isDirectory()) {
        if (!this.nodes.get(remotePath)?.isDir) this.nodes.set(remotePath, { isDir: true, revision: this.revision++ })
        return
      }
      const data = await readFile(local)
      const existing = this.nodes.get(remotePath)
      if (existing?.data !== undefined && Buffer.from(existing.data).equals(data)) return
      this.mkdirRecord(posix.dirname(remotePath))
      this.nodes.set(remotePath, { data, isDir: false, revision: this.revision++ })
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      this.nodes.delete(remotePath)
    }
  }
}
