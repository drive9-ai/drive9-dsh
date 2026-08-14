import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, open, readFile, stat as localStat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { StatResult } from 'drive9'
import { defaultClientFactory, isConflict, statusCodeOf } from './client.js'
import type { Drive9Client, Drive9ClientFactory } from './client.js'
import { WorkspaceTargetCodec } from './path.js'
import { applyLiteralEdit, decodeText, decodeTextStream, normalizeLineEndings, throwIfAborted } from './text.js'

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_CAS_ATTEMPTS = 4
const DEFAULT_COHERENCE_TIMEOUT_MS = 10_000
const DEFAULT_COHERENCE_POLL_MS = 50
const MAX_BATCH_STAT_PATHS = 256

export interface Drive9FileSystemConfig {
  mountRoot?: string
  remoteRoot?: string
  baseUrl?: string
  apiKey: string
  diffBasisMaxBytes?: number
  casAttempts?: number
  coherenceTimeoutMs?: number
  coherencePollMs?: number
  verifyCoherence?: boolean
}

interface ResolvedConfig {
  readonly mountRoot: string
  readonly remoteRoot: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly diffBasisMaxBytes: number
  readonly casAttempts: number
  readonly coherenceTimeoutMs: number
  readonly coherencePollMs: number
  readonly verifyCoherence: boolean
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`drive9-dsh: ${name} must be a positive safe integer`)
  return value
}

function resolveConfig(config: Drive9FileSystemConfig): ResolvedConfig {
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new TypeError('drive9-dsh: filesystem apiKey is required for SDK-backed revision CAS')
  }
  return {
    mountRoot: config.mountRoot ?? '/mnt/drive9',
    remoteRoot: config.remoteRoot ?? '/',
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    diffBasisMaxBytes: positiveSafeInteger(config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES, 'diffBasisMaxBytes'),
    casAttempts: positiveSafeInteger(config.casAttempts ?? DEFAULT_CAS_ATTEMPTS, 'casAttempts'),
    coherenceTimeoutMs: positiveSafeInteger(config.coherenceTimeoutMs ?? DEFAULT_COHERENCE_TIMEOUT_MS, 'coherenceTimeoutMs'),
    coherencePollMs: positiveSafeInteger(config.coherencePollMs ?? DEFAULT_COHERENCE_POLL_MS, 'coherencePollMs'),
    verifyCoherence: config.verifyCoherence ?? true,
  }
}

function revisionToken(revision: number): ReturnType<typeof FsVersion> {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new FsError('Drive9 returned an invalid file revision', 'FS_IO_ERROR')
  }
  return FsVersion(`d9rev:v1:${revision}`)
}

function parseRevision(version: ReturnType<typeof FsVersion>): number {
  const match = /^d9rev:v1:(\d+)$/u.exec(String(version))
  if (match?.[1] === undefined) throw new FsError('version was not issued by Drive9', 'FS_STALE_VERSION')
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision) || revision < 1) throw new FsError('Drive9 version is invalid', 'FS_STALE_VERSION')
  return revision
}

function isSymlinkMode(mode: number | undefined, hasMode: boolean | undefined): boolean {
  return hasMode === true && mode !== undefined && (mode & 0o170000) === 0o120000
}

function infoType(info: StatResult): FsInfo['type'] {
  if (isSymlinkMode(info.mode, info.hasMode)) return 'other'
  return info.isDir ? 'directory' : 'file'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class Drive9FileSystem extends FileSystem {
  static Config: z<Drive9FileSystemConfig> = z.object({
    mountRoot: z.string().default('/mnt/drive9'),
    remoteRoot: z.string().default('/'),
    baseUrl: z.string(),
    apiKey: z.string().required().role('secret'),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
    casAttempts: z.number().default(DEFAULT_CAS_ATTEMPTS),
    coherenceTimeoutMs: z.number().default(DEFAULT_COHERENCE_TIMEOUT_MS),
    coherencePollMs: z.number().default(DEFAULT_COHERENCE_POLL_MS),
    verifyCoherence: z.boolean().default(true),
  })

  readonly config: ResolvedConfig
  readonly client: Drive9Client
  readonly targets: WorkspaceTargetCodec
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    ctx: Context,
    config: Drive9FileSystemConfig,
    clientFactory: Drive9ClientFactory = defaultClientFactory,
  ) {
    super(ctx)
    this.config = resolveConfig(config)
    this.client = clientFactory(this.config.baseUrl, this.config.apiKey)
    this.targets = new WorkspaceTargetCodec(this.config.mountRoot, this.config.remoteRoot)
  }

  protected async [Service.init](): Promise<void> {
    await this.initialize()
  }

  async initialize(): Promise<void> {
    let mountInfo
    try {
      mountInfo = await localStat(this.config.mountRoot)
      await access(this.config.mountRoot, fsConstants.R_OK | fsConstants.W_OK)
    } catch (error: unknown) {
      throw new Error(`drive9-dsh: mountRoot "${this.config.mountRoot}" is not readable and writable`, { cause: error })
    }
    if (!mountInfo.isDirectory()) throw new Error(`drive9-dsh: mountRoot "${this.config.mountRoot}" is not a directory`)
    await this.targets.initialize()

    const remote = await this.statRemoteRequired(this.config.remoteRoot, 'initialize')
    if (!remote.isDir) throw new Error(`drive9-dsh: remoteRoot "${this.config.remoteRoot}" is not a directory`)
    if (this.config.verifyCoherence) await this.proveCoherence()
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    throwIfAborted(opts?.signal, 'resolve')
    try {
      const target = await this.targets.resolve(path, opts?.cwd)
      throwIfAborted(opts?.signal, 'resolve')
      return target
    } catch (error: unknown) {
      throw this.mapFsError(error, 'resolve', path)
    }
  }

  override processPath(target: FsTarget): string {
    return this.targets.decode(target).processPath
  }

  override fileUrl(target: FsTarget): string {
    return this.targets.fileUrl(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return this.targets.contains(parent, child)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    throwIfAborted(signal, 'stat')
    const decoded = this.targets.decode(target)
    const info = await this.statRemote(decoded.remotePath, 'stat', target.displayPath)
    throwIfAborted(signal, 'stat')
    if (info === undefined) return undefined
    return {
      version: revisionToken(info.revision),
      type: infoType(info),
      ...(info.isDir ? {} : { size: info.size }),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    throwIfAborted(signal, 'lstat')
    try {
      const info = await this.targets.lstat(path, opts?.cwd)
      throwIfAborted(signal, 'lstat')
      return info
    } catch (error: unknown) {
      throw this.mapFsError(error, 'lstat', path)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, 'read')
    const decoded = this.targets.decode(target)
    const info = await this.requireRegularFile(decoded.remotePath, target.displayPath, 'read')
    if (info.size > Number.MAX_SAFE_INTEGER) throw new FsError('file is too large to read safely', 'FS_TOO_LARGE')
    try {
      const bytes = await this.client.read(decoded.remotePath)
      throwIfAborted(signal, 'read')
      return decodeText(bytes, target.displayPath)
    } catch (error: unknown) {
      throw this.mapFsError(error, 'read', target.displayPath)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    throwIfAborted(signal, 'read')
    const decoded = this.targets.decode(target)
    await this.requireRegularFile(decoded.remotePath, target.displayPath, 'read')
    try {
      const stream = await this.client.readStream(decoded.remotePath)
      const decodedStream = decodeTextStream(stream, target.displayPath, signal)
      const mapError = this.mapFsError.bind(this)
      return {
        async * [Symbol.asyncIterator]() {
          try {
            yield* decodedStream
          } catch (error: unknown) {
            throw mapError(error, 'read', target.displayPath)
          }
        },
      }
    } catch (error: unknown) {
      throw this.mapFsError(error, 'read', target.displayPath)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes === Number.MAX_SAFE_INTEGER) {
      throw new FsError('maxBytes must be a non-negative safe integer below Number.MAX_SAFE_INTEGER', 'FS_TOO_LARGE')
    }
    throwIfAborted(signal, 'read')
    const decoded = this.targets.decode(target)
    const info = await this.requireRegularFile(decoded.remotePath, target.displayPath, 'read')
    if (info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    try {
      const bytes = await this.client.readAt(decoded.remotePath, 0, maxBytes + 1)
      throwIfAborted(signal, 'read')
      if (bytes.byteLength > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      return bytes
    } catch (error: unknown) {
      throw this.mapFsError(error, 'read', target.displayPath)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    throwIfAborted(signal, 'list')
    const decoded = this.targets.decode(target)
    const parent = await this.statRemote(decoded.remotePath, 'list', target.displayPath)
    if (parent === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (!parent.isDir) throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')

    let listed
    try {
      listed = await this.client.list(decoded.remotePath)
    } catch (error: unknown) {
      throw this.mapFsError(error, 'list', target.displayPath)
    }
    throwIfAborted(signal, 'list')
    listed.sort((left, right) => left.name.localeCompare(right.name))

    const resolved: Array<{ name: string; target: FsTarget; remotePath: string; fallbackSize?: number }> = []
    for (const entry of listed) {
      throwIfAborted(signal, 'list')
      if (entry.name.length === 0 || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\')) {
        throw new FsError(`Drive9 returned an invalid child name for "${target.displayPath}"`, 'FS_IO_ERROR')
      }
      const child = await this.targets.resolve(join(decoded.processPath, entry.name))
      const childDecoded = this.targets.decode(child)
      resolved.push({
        name: entry.name,
        target: child,
        remotePath: childDecoded.remotePath,
        ...(entry.isDir ? {} : { fallbackSize: entry.size }),
      })
    }

    const metadata = new Map<string, Awaited<ReturnType<Drive9Client['batchStat']>>[number]>()
    for (let offset = 0; offset < resolved.length; offset += MAX_BATCH_STAT_PATHS) {
      throwIfAborted(signal, 'list')
      const paths = resolved.slice(offset, offset + MAX_BATCH_STAT_PATHS).map(entry => entry.remotePath)
      let batch
      try {
        batch = await this.client.batchStat(paths)
      } catch (error: unknown) {
        throw this.mapFsError(error, 'list', target.displayPath)
      }
      for (const item of batch) metadata.set(item.path, item)
    }

    for (const entry of resolved) {
      const item = metadata.get(entry.remotePath)
      const valid = item?.status === 200
        && typeof item.isDir === 'boolean'
        && item.revision !== undefined
        && Number.isSafeInteger(item.revision)
        && item.revision >= 1
        && (item.isDir || (item.size !== undefined && Number.isSafeInteger(item.size) && item.size >= 0))
      if (valid) continue
      if (item?.status === 401 || item?.status === 403) {
        throw new FsError(`cannot list "${target.displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
      }
      throw new FsError(`cannot list "${target.displayPath}": Drive9 returned incomplete child metadata`, 'FS_IO_ERROR')
    }

    return resolved.map((entry) => {
      const item = metadata.get(entry.remotePath)!
      const type = isSymlinkMode(item.mode, item.hasMode) ? 'other' : item.isDir ? 'directory' : 'file'
      return {
        name: entry.name,
        target: entry.target,
        type,
        version: revisionToken(item.revision!),
        ...(type === 'file' ? { size: item.size ?? entry.fallbackSize ?? 0 } : {}),
      }
    })
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    if (content.includes('\0')) throw new FsError(`cannot write "${target.displayPath}": NUL is not text`, 'FS_NOT_TEXT')
    return this.withLock(String(target.targetKey), async () => {
      if (expected !== undefined) return this.guardedWrite(target, content, expected, signal)
      for (let attempt = 0; attempt < this.config.casAttempts; attempt += 1) {
        throwIfAborted(signal, 'write')
        const decoded = this.targets.decode(target)
        const existing = await this.statRemote(decoded.remotePath, 'write', target.displayPath)
        if (existing !== undefined && (existing.isDir || isSymlinkMode(existing.mode, existing.hasMode))) {
          throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        }
        const before = existing === undefined ? null : await this.readDiffBasis(decoded.remotePath, target.displayPath, existing)
        try {
          const revision = await this.client.writeWithRevision(
            decoded.remotePath,
            Buffer.from(content, 'utf8'),
            { expectedRevision: existing?.revision ?? 0 },
          )
          await this.waitForMountBytes(decoded.processPath, Buffer.from(content, 'utf8'))
          return {
            operation: existing === undefined ? 'create' : 'update',
            version: revisionToken(revision),
            before,
            after: normalizeLineEndings(content),
          }
        } catch (error: unknown) {
          if (isConflict(error)) continue
          throw this.mapFsError(error, 'write', target.displayPath)
        }
      }
      throw new FsError(`cannot write "${target.displayPath}": Drive9 CAS retries were exhausted`, 'FS_IO_ERROR')
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (edit.oldString.includes('\0') || edit.newString.includes('\0')) {
      throw new FsError(`cannot edit "${target.displayPath}": NUL is not text`, 'FS_NOT_TEXT')
    }
    return this.withLock(String(target.targetKey), async () => {
      const decoded = this.targets.decode(target)
      if (expected !== undefined) {
        const revision = parseRevision(expected.version)
        const existing = await this.requireRegularFile(decoded.remotePath, target.displayPath, 'edit')
        if (existing.revision !== revision) {
          throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
        const raw = await this.readCurrentText(decoded.remotePath, target.displayPath, signal, 'edit')
        const edited = applyLiteralEdit(raw, edit, target.displayPath)
        throwIfAborted(signal, 'edit')
        try {
          const nextRevision = await this.client.writeWithRevision(
            decoded.remotePath,
            Buffer.from(edited.storage, 'utf8'),
            { expectedRevision: revision },
          )
          await this.waitForMountBytes(decoded.processPath, Buffer.from(edited.storage, 'utf8'))
          return { version: revisionToken(nextRevision), before: edited.before, after: edited.after }
        } catch (error: unknown) {
          if (isConflict(error)) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
          throw this.mapFsError(error, 'edit', target.displayPath)
        }
      }

      for (let attempt = 0; attempt < this.config.casAttempts; attempt += 1) {
        throwIfAborted(signal, 'edit')
        const existing = await this.requireRegularFile(decoded.remotePath, target.displayPath, 'edit')
        const raw = await this.readCurrentText(decoded.remotePath, target.displayPath, signal, 'edit')
        const edited = applyLiteralEdit(raw, edit, target.displayPath)
        try {
          const nextRevision = await this.client.writeWithRevision(
            decoded.remotePath,
            Buffer.from(edited.storage, 'utf8'),
            { expectedRevision: existing.revision },
          )
          await this.waitForMountBytes(decoded.processPath, Buffer.from(edited.storage, 'utf8'))
          return { version: revisionToken(nextRevision), before: edited.before, after: edited.after }
        } catch (error: unknown) {
          if (isConflict(error)) continue
          throw this.mapFsError(error, 'edit', target.displayPath)
        }
      }
      throw new FsError(`cannot edit "${target.displayPath}": Drive9 CAS retries were exhausted`, 'FS_IO_ERROR')
    })
  }

  private async guardedWrite(
    target: FsTarget,
    content: string,
    expected: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    throwIfAborted(signal, 'write')
    const decoded = this.targets.decode(target)
    const existing = await this.statRemote(decoded.remotePath, 'write', target.displayPath)
    if (existing !== undefined && (existing.isDir || isSymlinkMode(existing.mode, existing.hasMode))) {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without observing it first`, 'FS_NOT_OBSERVED')
    }
    if (expected.kind === 'replaceIfVersion' && existing === undefined) {
      throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
    }
    const expectedRevision = expected.kind === 'createIfAbsent' ? 0 : parseRevision(expected.version)
    if (expected.kind === 'replaceIfVersion' && existing?.revision !== expectedRevision) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const before = existing === undefined ? null : await this.readDiffBasis(decoded.remotePath, target.displayPath, existing)
    throwIfAborted(signal, 'write')
    try {
      const revision = await this.client.writeWithRevision(
        decoded.remotePath,
        Buffer.from(content, 'utf8'),
        { expectedRevision },
      )
      await this.waitForMountBytes(decoded.processPath, Buffer.from(content, 'utf8'))
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: revisionToken(revision),
        before,
        after: normalizeLineEndings(content),
      }
    } catch (error: unknown) {
      if (isConflict(error)) {
        const code = expected.kind === 'createIfAbsent' ? 'FS_NOT_OBSERVED' : 'FS_STALE_VERSION'
        throw new FsError(`cannot write "${target.displayPath}": Drive9 revision conflict`, code)
      }
      throw this.mapFsError(error, 'write', target.displayPath)
    }
  }

  private async readCurrentText(
    remotePath: string,
    displayPath: string,
    signal: AbortSignal | undefined,
    verb: 'edit',
  ): Promise<string> {
    throwIfAborted(signal, verb)
    try {
      const raw = await this.client.read(remotePath)
      throwIfAborted(signal, verb)
      return decodeText(raw, displayPath, verb)
    } catch (error: unknown) {
      throw this.mapFsError(error, verb, displayPath)
    }
  }

  private async readDiffBasis(remotePath: string, displayPath: string, info: StatResult): Promise<string | null> {
    if (info.size >= this.config.diffBasisMaxBytes) return null
    try {
      const raw = await this.client.read(remotePath)
      if (raw.byteLength >= this.config.diffBasisMaxBytes) return null
      try {
        return normalizeLineEndings(decodeText(raw, displayPath))
      } catch (error: unknown) {
        if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
        throw error
      }
    } catch (error: unknown) {
      throw this.mapFsError(error, 'read', displayPath)
    }
  }

  private async requireRegularFile(
    remotePath: string,
    displayPath: string,
    verb: 'read' | 'edit',
  ): Promise<StatResult> {
    const info = await this.statRemote(remotePath, verb, displayPath)
    if (info === undefined) {
      const code = verb === 'edit' ? 'FS_STALE_VERSION' : 'FS_NOT_FOUND'
      throw new FsError(`cannot ${verb} "${displayPath}": not found`, code)
    }
    if (info.isDir || isSymlinkMode(info.mode, info.hasMode)) {
      throw new FsError(`cannot ${verb} "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    return info
  }

  private async statRemote(
    remotePath: string,
    verb: string,
    displayPath: string,
  ): Promise<StatResult | undefined> {
    try {
      const info = await this.client.stat(remotePath)
      if (!Number.isSafeInteger(info.revision) || info.revision < 1
        || !Number.isSafeInteger(info.size) || info.size < 0
        || typeof info.isDir !== 'boolean') {
        throw new FsError(`cannot ${verb} "${displayPath}": Drive9 returned invalid metadata`, 'FS_IO_ERROR')
      }
      return info
    } catch (error: unknown) {
      if (statusCodeOf(error) === 404) return undefined
      throw this.mapFsError(error, verb, displayPath)
    }
  }

  private async statRemoteRequired(remotePath: string, verb: string): Promise<StatResult> {
    const info = await this.statRemote(remotePath, verb, remotePath)
    if (info === undefined) throw new Error(`drive9-dsh: remote path "${remotePath}" was not found`)
    return info
  }

  private mapFsError(error: unknown, verb: string, displayPath: string): FsError {
    if (error instanceof FsError) return error
    const status = statusCodeOf(error)
    if (status === 401 || status === 403) {
      return new FsError(`cannot ${verb} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
    }
    if (status === 404) return new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
    return new FsError(`cannot ${verb} "${displayPath}": Drive9 I/O failed (${messageOf(error)})`, 'FS_IO_ERROR', { cause: error })
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private async waitForMountBytes(processPath: string, expected: Uint8Array): Promise<void> {
    const deadline = Date.now() + this.config.coherenceTimeoutMs
    while (true) {
      try {
        const actual = await readFile(processPath)
        if (actual.equals(Buffer.from(expected))) return
      } catch (error: unknown) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw this.mapFsError(error, 'verify', processPath)
      }
      if (Date.now() >= deadline) {
        throw new FsError(`Drive9 mount did not expose committed bytes for "${processPath}"`, 'FS_IO_ERROR')
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, this.config.coherencePollMs))
    }
  }

  private async waitForSdkBytes(remotePath: string, expected: Uint8Array, newerThan: number): Promise<number> {
    const deadline = Date.now() + this.config.coherenceTimeoutMs
    while (true) {
      try {
        const info = await this.client.stat(remotePath)
        if (info.revision > newerThan) {
          const actual = await this.client.read(remotePath)
          if (Buffer.from(actual).equals(Buffer.from(expected))) return info.revision
        }
      } catch (error: unknown) {
        if (statusCodeOf(error) !== 404) throw error
      }
      if (Date.now() >= deadline) throw new Error('drive9-dsh: mount writes are not visible through the Drive9 SDK')
      await new Promise(resolveSleep => setTimeout(resolveSleep, this.config.coherencePollMs))
    }
  }

  private async waitForProbeDeletion(remotePath: string, processPath: string): Promise<void> {
    const deadline = Date.now() + this.config.coherenceTimeoutMs
    while (true) {
      const remoteMissing = await this.statRemote(remotePath, 'cleanup', remotePath) === undefined
      let localMissing = false
      try {
        await localStat(processPath)
      } catch (error: unknown) {
        localMissing = error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        if (!localMissing) throw error
      }
      if (remoteMissing && localMissing) return
      if (Date.now() >= deadline) throw new Error('drive9-dsh: coherence probe cleanup did not converge')
      await new Promise(resolveSleep => setTimeout(resolveSleep, this.config.coherencePollMs))
    }
  }

  private async proveCoherence(): Promise<void> {
    const name = `.drive9-dsh-coherence-${randomBytes(16).toString('hex')}`
    const remotePath = posix.join(this.config.remoteRoot, name)
    const target = this.targets.targetForRemotePath(remotePath)
    const processPath = this.processPath(target)
    const first = randomBytes(32)
    const second = randomBytes(32)
    let created = false
    try {
      const firstRevision = await this.client.writeWithRevision(remotePath, first, { expectedRevision: 0 })
      created = true
      await this.waitForMountBytes(processPath, first)
      await writeFile(processPath, second)
      const handle = await open(processPath, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.waitForSdkBytes(remotePath, second, firstRevision)
      await this.client.delete(remotePath)
      await this.waitForProbeDeletion(remotePath, processPath)
      created = false
    } catch (error: unknown) {
      throw new Error(`drive9-dsh: workspace mount/SDK coherence proof failed for "${basename(processPath)}"`, { cause: error })
    } finally {
      if (created) {
        try {
          await this.client.delete(remotePath)
        } catch {}
        try {
          await unlink(processPath)
        } catch {}
      }
    }
  }
}

export default Drive9FileSystem
