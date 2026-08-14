import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defaultClientFactory, isConflict, statusCodeOf } from './client.js'
import type { Drive9Client, Drive9ClientFactory } from './client.js'
import { Drive9ResultError } from './result-error.js'
import { encodeLocator, encodeReceipt, parseLocator, RECEIPT_MARKER } from './receipt.js'
import type { EvidenceReceiptV1 } from './receipt.js'

const MANIFEST_MAX_BYTES = 64 * 1024
const CAPABILITY_ATTEMPTS = 3

export interface Drive9EvidenceConfig {
  root?: string
  baseUrl?: string
  apiKey: string
  workspaceApiKey?: string
}

interface ResolvedConfig {
  readonly root: string
  readonly baseUrl?: string
  readonly apiKey?: string
}

export interface EvidenceManifestV1 {
  readonly schema: 'drive9-dsh-evidence/v1'
  readonly capability: string
  readonly locator: string
  readonly sessionId: SessionId
  readonly toolName: string
  readonly callId: CallId
  readonly label: string
  readonly suggestedName: string
  readonly bytes: number
  readonly sha256: string
  readonly createdAt: string
  readonly contentPath: string
}

export interface PublishedEvidence {
  readonly locator: string
  readonly manifest: EvidenceManifestV1
  readonly manifestSha256: string
  readonly content: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false
    }
  }
  return true
}

function resolvedConfig(config: Drive9EvidenceConfig): ResolvedConfig {
  const root = posix.normalize(config.root ?? '/evidence/dsh')
  if (!posix.isAbsolute(root) || root.includes('\0')) throw new TypeError('drive9-dsh: evidence root must be an absolute POSIX path')
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new TypeError('drive9-dsh: evidence apiKey is required and must be separate from workspace mount credentials')
  }
  if (config.workspaceApiKey !== undefined && config.workspaceApiKey === config.apiKey) {
    throw new TypeError('drive9-dsh: workspace and evidence must use different scoped credentials')
  }
  return {
    root,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    apiKey: config.apiKey,
  }
}

function serializeManifest(manifest: EvidenceManifestV1): Uint8Array {
  return Buffer.from(JSON.stringify({
    schema: manifest.schema,
    capability: manifest.capability,
    locator: manifest.locator,
    sessionId: manifest.sessionId,
    toolName: manifest.toolName,
    callId: manifest.callId,
    label: manifest.label,
    suggestedName: manifest.suggestedName,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    createdAt: manifest.createdAt,
    contentPath: manifest.contentPath,
  }), 'utf8')
}

function parseManifest(bytes: Uint8Array): EvidenceManifestV1 {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error: unknown) {
    throw new Drive9ResultError('Drive9 evidence manifest is not valid JSON', 'DRIVE9_RESULT_CORRUPT', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Drive9ResultError('Drive9 evidence manifest is malformed', 'DRIVE9_RESULT_CORRUPT')
  }
  const record = value as Record<string, unknown>
  const expectedKeys = [
    'bytes', 'callId', 'capability', 'contentPath', 'createdAt', 'label', 'locator',
    'schema', 'sessionId', 'sha256', 'suggestedName', 'toolName',
  ]
  if (Object.keys(record).sort().join(',') !== expectedKeys.sort().join(',')) {
    throw new Drive9ResultError('Drive9 evidence manifest has an unsupported shape', 'DRIVE9_RESULT_CORRUPT')
  }
  if (record.schema !== 'drive9-dsh-evidence/v1'
    || typeof record.capability !== 'string'
    || typeof record.locator !== 'string'
    || typeof record.sessionId !== 'string'
    || typeof record.toolName !== 'string'
    || typeof record.callId !== 'string'
    || typeof record.label !== 'string'
    || typeof record.suggestedName !== 'string'
    || typeof record.bytes !== 'number'
    || !Number.isSafeInteger(record.bytes)
    || record.bytes < 0
    || typeof record.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.sha256)
    || typeof record.createdAt !== 'string'
    || Number.isNaN(Date.parse(record.createdAt))
    || typeof record.contentPath !== 'string') {
    throw new Drive9ResultError('Drive9 evidence manifest has invalid fields', 'DRIVE9_RESULT_CORRUPT')
  }
  const manifest = record as unknown as EvidenceManifestV1
  if (!Buffer.from(serializeManifest(manifest)).equals(Buffer.from(bytes))) {
    throw new Drive9ResultError('Drive9 evidence manifest is not canonical', 'DRIVE9_RESULT_CORRUPT')
  }
  return manifest
}

export class Drive9EvidenceStore extends SpillStore {
  static Config: z<Drive9EvidenceConfig> = z.object({
    root: z.string().default('/evidence/dsh'),
    baseUrl: z.string(),
    apiKey: z.string().required().role('secret'),
    workspaceApiKey: z.string().role('secret'),
  })

  readonly config: ResolvedConfig
  readonly client: Drive9Client

  constructor(
    ctx: Context,
    config: Drive9EvidenceConfig,
    clientFactory: Drive9ClientFactory = defaultClientFactory,
  ) {
    super(ctx)
    this.config = resolvedConfig(config)
    this.client = clientFactory(this.config.baseUrl, this.config.apiKey)
  }

  protected async [Service.init](): Promise<void> {
    await this.initialize()
  }

  async initialize(): Promise<void> {
    try {
      const info = await this.client.stat(this.config.root)
      if (!info.isDir) throw new Error('not a directory')
    } catch (error: unknown) {
      throw new Error(`drive9-dsh: evidence root "${this.config.root}" is unavailable or not a directory`, { cause: error })
    }
  }

  override async saveText(input: SaveTextSpill): Promise<SpillRef> {
    this.validateSaveInput(input)
    const content = Buffer.from(input.content, 'utf8')
    for (let attempt = 0; attempt < CAPABILITY_ATTEMPTS; attempt += 1) {
      const capability = randomBytes(32).toString('base64url')
      const paths = this.paths(capability)
      const locator = encodeLocator(capability)
      const manifest: EvidenceManifestV1 = {
        schema: 'drive9-dsh-evidence/v1',
        capability,
        locator,
        sessionId: input.owner.sessionId,
        toolName: input.source.toolName,
        callId: input.source.callId,
        label: input.source.label,
        suggestedName: input.suggestedName,
        bytes: content.byteLength,
        sha256: sha256(content),
        createdAt: new Date().toISOString(),
        contentPath: paths.content,
      }
      const manifestBytes = serializeManifest(manifest)
      if (manifestBytes.byteLength > MANIFEST_MAX_BYTES) {
        throw new Drive9ResultError('Drive9 evidence metadata exceeds the manifest limit', 'DRIVE9_RESULT_IO')
      }
      const manifestSha256 = sha256(manifestBytes)
      try {
        await this.client.writeWithRevision(paths.content, content, { expectedRevision: 0 })
      } catch (error: unknown) {
        if (isConflict(error)) continue
        throw this.storageError('content publication failed', error)
      }
      try {
        await this.client.writeWithRevision(paths.manifest, manifestBytes, { expectedRevision: 0 })
      } catch (error: unknown) {
        throw this.storageError('manifest publication failed after content durability', error)
      }
      const receipt: EvidenceReceiptV1 = {
        v: 1,
        locator,
        sessionId: input.owner.sessionId,
        toolName: input.source.toolName,
        callId: input.source.callId,
        manifestSha256,
      }
      return {
        locator: SpillLocator(locator),
        bytes: content.byteLength,
        retrievalHint: `Use result_read or result_search with this exact result_id. ${RECEIPT_MARKER}${encodeReceipt(receipt)}`,
      }
    }
    throw new Drive9ResultError('Drive9 evidence capability allocation failed', 'DRIVE9_RESULT_IO')
  }

  async readPublished(locator: string, maxBytes: number, signal?: AbortSignal): Promise<PublishedEvidence> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Drive9ResultError('Drive9 result scan limit is invalid', 'DRIVE9_RESULT_SCAN_LIMIT')
    }
    if (signal?.aborted) throw new Drive9ResultError('Drive9 result read aborted', 'DRIVE9_RESULT_ABORTED')
    const capability = parseLocator(locator)
    if (capability === undefined) throw new Drive9ResultError('Drive9 result_id is malformed', 'DRIVE9_RESULT_INVALID_ID')
    const paths = this.paths(capability)
    const manifestState = await this.readStable(paths.manifest, MANIFEST_MAX_BYTES, 'manifest', signal)
    const manifest = parseManifest(manifestState.bytes)
    const manifestSha256 = sha256(manifestState.bytes)
    if (manifest.capability !== capability
      || manifest.locator !== locator
      || manifest.contentPath !== paths.content) {
      throw new Drive9ResultError('Drive9 evidence manifest does not match its locator', 'DRIVE9_RESULT_CORRUPT')
    }
    if (manifest.bytes > maxBytes) {
      throw new Drive9ResultError(
        `Drive9 result is ${manifest.bytes} bytes; the request scan limit is ${maxBytes}`,
        'DRIVE9_RESULT_SCAN_LIMIT',
      )
    }
    const contentState = await this.readStable(paths.content, maxBytes, 'content', signal)
    if (contentState.bytes.byteLength !== manifest.bytes || sha256(contentState.bytes) !== manifest.sha256) {
      throw new Drive9ResultError('Drive9 evidence content failed integrity verification', 'DRIVE9_RESULT_CORRUPT')
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(contentState.bytes)
    } catch (error: unknown) {
      throw new Drive9ResultError('Drive9 evidence content is not valid UTF-8', 'DRIVE9_RESULT_CORRUPT', { cause: error })
    }
    return { locator, manifest, manifestSha256, content }
  }

  private paths(capability: string): { content: string; manifest: string } {
    const prefix = capability.slice(0, 2)
    return {
      content: posix.join(this.config.root, 'objects', prefix, `${capability}.txt`),
      manifest: posix.join(this.config.root, 'manifests', prefix, `${capability}.json`),
    }
  }

  private async readStable(
    path: string,
    maxBytes: number,
    kind: 'manifest' | 'content',
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; revision: number }> {
    let before
    try {
      before = await this.client.stat(path)
    } catch (error: unknown) {
      if (statusCodeOf(error) === 404) {
        const code = kind === 'manifest' ? 'DRIVE9_RESULT_NOT_FOUND' : 'DRIVE9_RESULT_CORRUPT'
        throw new Drive9ResultError(`Drive9 evidence ${kind} is missing`, code, { cause: error })
      }
      throw this.storageError(`${kind} metadata read failed`, error)
    }
    if (before.isDir) throw new Drive9ResultError(`Drive9 evidence ${kind} is not a file`, 'DRIVE9_RESULT_CORRUPT')
    if (before.size > maxBytes) {
      throw new Drive9ResultError(`Drive9 evidence ${kind} exceeds the request scan limit`, 'DRIVE9_RESULT_SCAN_LIMIT')
    }
    if (signal?.aborted) throw new Drive9ResultError('Drive9 result read aborted', 'DRIVE9_RESULT_ABORTED')
    let bytes
    try {
      bytes = await this.client.read(path)
    } catch (error: unknown) {
      if (statusCodeOf(error) === 404) throw new Drive9ResultError(`Drive9 evidence ${kind} disappeared`, 'DRIVE9_RESULT_CORRUPT')
      throw this.storageError(`${kind} read failed`, error)
    }
    if (bytes.byteLength > maxBytes) {
      throw new Drive9ResultError(`Drive9 evidence ${kind} exceeds the request scan limit`, 'DRIVE9_RESULT_SCAN_LIMIT')
    }
    if (signal?.aborted) throw new Drive9ResultError('Drive9 result read aborted', 'DRIVE9_RESULT_ABORTED')
    let after
    try {
      after = await this.client.stat(path)
    } catch (error: unknown) {
      throw new Drive9ResultError(`Drive9 evidence ${kind} changed during verification`, 'DRIVE9_RESULT_CORRUPT', { cause: error })
    }
    if (before.revision !== after.revision || before.size !== after.size || bytes.byteLength !== before.size) {
      throw new Drive9ResultError(`Drive9 evidence ${kind} changed during verification`, 'DRIVE9_RESULT_CORRUPT')
    }
    return { bytes, revision: before.revision }
  }

  private validateSaveInput(input: SaveTextSpill): void {
    if (String(input.owner.sessionId).length === 0
      || input.source.toolName.length === 0
      || String(input.source.callId).length === 0
      || input.source.label.length === 0
      || input.suggestedName.length === 0) {
      throw new Drive9ResultError('Drive9 evidence metadata is incomplete', 'DRIVE9_RESULT_IO')
    }
    if (![input.content, input.source.toolName, String(input.source.callId), input.source.label, input.suggestedName]
      .every(isWellFormedUnicode)) {
      throw new Drive9ResultError('Drive9 evidence text contains invalid Unicode', 'DRIVE9_RESULT_IO')
    }
  }

  private storageError(message: string, error: unknown): Drive9ResultError {
    const status = statusCodeOf(error)
    const suffix = status === 401 || status === 403 ? 'permission denied' : 'Drive9 I/O failed'
    return new Drive9ResultError(`${message}: ${suffix}`, 'DRIVE9_RESULT_IO', { cause: error })
  }
}

export default Drive9EvidenceStore
