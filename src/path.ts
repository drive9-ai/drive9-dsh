import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { posix } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'

const EVIDENCE_PREFIX = 'drive9-result:v1:'

function nodeCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function isMissing(error: unknown): boolean {
  const code = nodeCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function pathContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function remoteContained(parent: string, child: string): boolean {
  const rel = posix.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
}

function validatePathInput(path: string): void {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  if (path.includes('\0') || path.includes('\\') || path.startsWith(EVIDENCE_PREFIX)) {
    throw new FsError('file_path is not a valid Drive9 workspace path', 'FS_SANDBOX_DENIED')
  }
}

async function canonicalizeMissing(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }

  const missing = [basename(path)]
  let ancestor = dirname(path)
  while (true) {
    try {
      const canonical = await realpath(ancestor)
      const info = await stat(canonical)
      if (!info.isDirectory()) {
        throw new FsError(`cannot resolve "${path}": a parent segment is not a directory`, 'FS_NOT_FOUND')
      }
      return join(canonical, ...missing)
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      if (!isMissing(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return path
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function canonicalizeMissingSync(path: string): string {
  try {
    return realpathSync(path)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }

  const missing = [basename(path)]
  let ancestor = dirname(path)
  while (true) {
    try {
      const canonical = realpathSync(ancestor)
      if (!statSync(canonical).isDirectory()) {
        throw new FsError(`cannot resolve "${path}": a parent segment is not a directory`, 'FS_NOT_FOUND')
      }
      return join(canonical, ...missing)
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      if (!isMissing(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return path
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

export interface DecodedWorkspaceTarget {
  readonly remotePath: string
  readonly processPath: string
}

export class WorkspaceTargetCodec {
  readonly mountRoot: string
  readonly remoteRoot: string
  private readonly instanceId = randomUUID()
  private readonly targetKey = randomBytes(32)
  private canonicalMountRoot?: string

  constructor(mountRoot: string, remoteRoot: string) {
    if (!isAbsolute(mountRoot)) throw new TypeError('drive9-dsh: mountRoot must be an absolute path')
    if (!posix.isAbsolute(remoteRoot)) throw new TypeError('drive9-dsh: remoteRoot must be an absolute POSIX path')
    if (mountRoot.includes('\0') || remoteRoot.includes('\0')) {
      throw new TypeError('drive9-dsh: roots must not contain NUL bytes')
    }
    this.mountRoot = resolve(mountRoot)
    this.remoteRoot = posix.normalize(remoteRoot)
  }

  async initialize(): Promise<string> {
    this.canonicalMountRoot = await realpath(this.mountRoot)
    return this.canonicalMountRoot
  }

  async resolve(path: string, cwd?: string): Promise<FsTarget> {
    validatePathInput(path)
    const root = this.requireCanonicalRoot()
    const base = cwd === undefined ? root : await this.canonicalizeCwd(cwd)
    const requested = isAbsolute(path) ? resolve(path) : resolve(base, path)
    if (!pathContained(root, requested)) {
      throw new FsError(`path "${path}" escapes the Drive9 workspace`, 'FS_SANDBOX_DENIED')
    }
    const canonical = await canonicalizeMissing(requested)
    if (!pathContained(root, canonical)) {
      throw new FsError(`path "${path}" escapes the Drive9 workspace through a symlink`, 'FS_SANDBOX_DENIED')
    }
    return this.targetForProcessPath(canonical)
  }

  decode(target: FsTarget): DecodedWorkspaceTarget {
    const raw = String(target.targetKey)
    const prefix = `d9fs:v1:${this.instanceId}:`
    if (!raw.startsWith(prefix)) {
      throw new FsError('target was not issued by this Drive9 filesystem', 'FS_IO_ERROR')
    }
    const payload = raw.slice(prefix.length)
    const separator = payload.lastIndexOf(':')
    if (separator <= 0) throw new FsError('target is malformed', 'FS_IO_ERROR')
    const encoded = payload.slice(0, separator)
    const signature = payload.slice(separator + 1)
    const expectedSignature = this.sign(encoded)
    if (!/^[0-9a-f]{64}$/u.test(signature)
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
      throw new FsError('target was not issued by this Drive9 filesystem', 'FS_IO_ERROR')
    }
    let remotePath: string
    try {
      const decoded = Buffer.from(encoded, 'base64url')
      if (decoded.toString('base64url') !== encoded) throw new Error('non-canonical target encoding')
      remotePath = decoded.toString('utf8')
    } catch (error: unknown) {
      throw new FsError('target is malformed', 'FS_IO_ERROR', { cause: error })
    }
    if (!posix.isAbsolute(remotePath) || !remoteContained(this.remoteRoot, remotePath)) {
      throw new FsError('target escapes the Drive9 workspace', 'FS_IO_ERROR')
    }
    const rel = posix.relative(this.remoteRoot, remotePath)
    const candidate = rel === '' ? this.requireCanonicalRoot() : join(this.requireCanonicalRoot(), ...rel.split('/'))
    const processPath = canonicalizeMissingSync(candidate)
    if (!pathContained(this.requireCanonicalRoot(), processPath)) {
      throw new FsError('target escapes the Drive9 mount', 'FS_IO_ERROR')
    }
    return { remotePath, processPath }
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const left = this.decode(parent)
    const right = this.decode(child)
    return remoteContained(left.remotePath, right.remotePath)
  }

  fileUrl(target: FsTarget): string {
    return pathToFileURL(this.decode(target).processPath).href
  }

  async lstat(path: string, cwd?: string): Promise<FsPathInfo | undefined> {
    validatePathInput(path)
    const root = this.requireCanonicalRoot()
    const base = cwd === undefined ? root : await this.canonicalizeCwd(cwd)
    const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
    if (!pathContained(root, absolute)) {
      throw new FsError(`path "${path}" escapes the Drive9 workspace`, 'FS_SANDBOX_DENIED')
    }
    const candidate = absolute === root
      ? root
      : join(await canonicalizeMissing(dirname(absolute)), basename(absolute))
    if (!pathContained(root, candidate)) {
      throw new FsError(`path "${path}" escapes the Drive9 workspace through a symlink`, 'FS_SANDBOX_DENIED')
    }
    try {
      const info = await lstat(candidate, { bigint: true })
      const version = FsVersion(`mount:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
      if (info.isSymbolicLink()) return { version, type: 'symlink', size: Number(info.size) }
      if (info.isFile()) return { version, type: 'file', size: Number(info.size) }
      if (info.isDirectory()) return { version, type: 'directory' }
      return { version, type: 'other' }
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  targetForRemotePath(remotePath: string): FsTarget {
    const normalized = posix.normalize(remotePath)
    if (!posix.isAbsolute(normalized) || !remoteContained(this.remoteRoot, normalized)) {
      throw new FsError('remote path escapes the Drive9 workspace', 'FS_IO_ERROR')
    }
    const rel = posix.relative(this.remoteRoot, normalized)
    const processPath = rel === '' ? this.requireCanonicalRoot() : join(this.requireCanonicalRoot(), ...rel.split('/'))
    return this.target(normalized, processPath)
  }

  private targetForProcessPath(processPath: string): FsTarget {
    const rel = relative(this.requireCanonicalRoot(), processPath)
    if (!pathContained(this.requireCanonicalRoot(), processPath)) {
      throw new FsError('path escapes the Drive9 mount', 'FS_IO_ERROR')
    }
    const remotePath = rel === ''
      ? this.remoteRoot
      : posix.join(this.remoteRoot, ...rel.split(sep))
    return this.target(remotePath, processPath)
  }

  private target(remotePath: string, processPath: string): FsTarget {
    const encoded = Buffer.from(remotePath, 'utf8').toString('base64url')
    const targetKey = FsTargetKey(`d9fs:v1:${this.instanceId}:${encoded}:${this.sign(encoded)}`)
    return {
      targetKey,
      displayPath: processPath,
    }
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.targetKey)
      .update(this.instanceId, 'utf8')
      .update('\0', 'utf8')
      .update(encoded, 'utf8')
      .digest('hex')
  }

  private async canonicalizeCwd(cwd: string): Promise<string> {
    validatePathInput(cwd)
    const canonical = await canonicalizeMissing(isAbsolute(cwd) ? resolve(cwd) : resolve(this.requireCanonicalRoot(), cwd))
    if (!pathContained(this.requireCanonicalRoot(), canonical)) {
      throw new FsError(`cwd "${cwd}" escapes the Drive9 workspace`, 'FS_SANDBOX_DENIED')
    }
    return canonical
  }

  private requireCanonicalRoot(): string {
    if (this.canonicalMountRoot === undefined) {
      throw new FsError('Drive9 filesystem has not completed startup validation', 'FS_IO_ERROR')
    }
    return this.canonicalMountRoot
  }
}
