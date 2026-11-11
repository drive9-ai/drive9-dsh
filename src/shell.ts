import { platform } from 'node:os'
import { posix } from 'node:path'
import { stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import ShellExecutor, { type ShellExecRequest, type ShellExecSpec, type ShellProcess, type ShellRunResult } from '@deepseek-ai/dsh-shell'
import type SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'
import { RuntimeBusyError, RuntimeCanceledError, RuntimeExecutionError, RuntimeNotEnabledError, RuntimeOutcomeUnknownError, RuntimeStartError, RuntimeTimeoutError } from 'drive9'
import type { Client, RuntimeCapabilities } from 'drive9'
import { Drive9FileSystem } from './filesystem.js'
import { Drive9EvidenceStore } from './evidence.js'
import { OutputTail } from './shell-output.js'

export interface Drive9ShellConfig {
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

const MAX_TIMEOUT_MS = 900_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const STARTUP_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 25_000

type RuntimeClient = Pick<Client, 'status' | 'runtimeCapabilities' | 'exec'>

function fail(code: string, message: string): HarnessError {
  return new HarnessError(`[DRIVE9_EXEC_${code}] ${message}`, `DRIVE9_EXEC_${code}`)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw fail('INVALID_REQUEST', `${name} must be a positive safe integer`)
  return value
}

function supportsRuntime(client: object): client is RuntimeClient {
  return ['status', 'runtimeCapabilities', 'exec'].every(key => key in client && typeof (client as Record<string, unknown>)[key] === 'function')
}

function checkCapabilities(caps: RuntimeCapabilities): void {
  if (!Number.isSafeInteger(caps.version) || caps.version < 2 || caps.streaming !== true || caps.cancel !== true) {
    throw fail('UNAVAILABLE', 'Runtime requires protocol v2, streaming and confirmed cancellation')
  }
  const path = caps.workspace_path
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.includes('\\') || posix.normalize(path) !== path) {
    throw fail('UNAVAILABLE', 'Runtime workspace_path must be a canonical absolute POSIX path')
  }
  for (const key of ['default_timeout_ms', 'max_timeout_ms', 'max_output_bytes'] as const) positiveInteger(caps[key], `Runtime ${key}`)
  if (caps.default_timeout_ms > caps.max_timeout_ms) throw fail('UNAVAILABLE', 'Runtime default timeout exceeds its maximum')
}

async function bounded<T>(work: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

export class Drive9Shell extends ShellExecutor {
  static inject = ['fs', 'spillStore', 'sandboxPolicy']
  static Config: z<Drive9ShellConfig> = z.object({
    timeoutMs: z.number().default(60_000),
    maxOutputBytes: z.number().default(64 * 1024),
  })

  private readonly filesystem: Drive9FileSystem
  private readonly evidence: Drive9EvidenceStore
  private readonly policy: SandboxPolicyService
  private client!: RuntimeClient
  private root = ''
  private timeoutCap = MAX_TIMEOUT_MS
  private outputCap = MAX_OUTPUT_BYTES
  private defaultTimeout: number
  private defaultOutput: number
  private ready = false
  private closing = false
  private closePromise: Promise<void> | undefined
  private readonly active = new Map<AbortController, Promise<ShellRunResult>>()

  constructor(ctx: Context, config: Drive9ShellConfig = {}) {
    super(ctx)
    this.filesystem = ctx.fs as Drive9FileSystem
    this.evidence = ctx.spillStore as Drive9EvidenceStore
    this.policy = ctx.sandboxPolicy
    this.defaultTimeout = positiveInteger(config.timeoutMs ?? 60_000, 'timeoutMs')
    this.defaultOutput = positiveInteger(config.maxOutputBytes ?? 64 * 1024, 'maxOutputBytes')
    ctx.effect(() => () => this.close())
  }

  override get sandboxMode(): SandboxMode { return this.policy.defaultMode }

  protected async [Service.init](): Promise<void> {
    await bounded(this.initialize(), STARTUP_TIMEOUT_MS, () => fail('UNAVAILABLE', 'Runtime startup checks timed out'))
    this.ready = true
  }

  private async initialize(): Promise<void> {
    if (platform() !== 'linux') throw fail('UNSUPPORTED', 'Runtime shell requires Linux with a strong-profile Drive9 FUSE mount')
    const fs = this.filesystem
    const evidence = this.evidence
    if (!(fs instanceof Drive9FileSystem) || !(evidence instanceof Drive9EvidenceStore) || fs.config.mountConsistency !== 'strong') {
      throw fail('UNSUPPORTED', 'Runtime shell requires Drive9 filesystem (strong) and Drive9 evidence providers')
    }
    if (!supportsRuntime(fs.client) || !('status' in evidence.client) || typeof evidence.client.status !== 'function') {
      throw fail('UNAVAILABLE', 'Runtime requires SDK capabilities and authenticated workspace/evidence identity checks')
    }
    this.client = fs.client
    const [caps, workspaceStatus, evidenceStatus] = await Promise.all([
      this.client.runtimeCapabilities(AbortSignal.timeout(STARTUP_TIMEOUT_MS)),
      this.client.status(),
      evidence.client.status() as Promise<{ tenant_id?: unknown }>,
    ])
    checkCapabilities(caps)
    const tenant = workspaceStatus.tenant_id
    const other = evidenceStatus.tenant_id
    if (typeof tenant !== 'string' || !tenant.trim() || typeof other !== 'string' || !other.trim() || tenant === other) {
      throw fail('UNSUPPORTED', 'Runtime workspace and evidence must have different authenticated tenant identities; separate token strings are insufficient')
    }
    this.root = fs.processPath(await fs.resolve(fs.config.mountRoot))
    if (this.root !== posix.join(caps.workspace_path, fs.config.remoteRoot)) {
      throw fail('UNSUPPORTED', 'Canonical mountRoot must equal Runtime workspace_path plus remoteRoot; command paths cannot be rewritten safely')
    }
    this.timeoutCap = Math.min(MAX_TIMEOUT_MS, caps.max_timeout_ms)
    this.outputCap = Math.min(MAX_OUTPUT_BYTES, caps.max_output_bytes)
    this.defaultTimeout = Math.min(this.defaultTimeout, this.timeoutCap)
    this.defaultOutput = Math.min(this.defaultOutput, this.outputCap)
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    if (this.closing) throw fail('CLOSED', 'Runtime shell is closing')
    if (!this.ready) throw fail('UNAVAILABLE', 'Runtime shell is not ready')
    if (typeof request.command !== 'string' || request.command.includes('\0')) throw fail('INVALID_REQUEST', 'command must be a string without NUL bytes')
    if (request.stdin !== undefined) throw fail('UNSUPPORTED', 'Runtime has no stdin API; use Bash heredoc or pipe syntax')
    const policy = request.sandboxPolicy ?? this.policy.resolve()
    if (policy.mode !== 'danger-full-access') throw fail('POLICY_DENIED', 'Runtime requires an explicitly approved danger-full-access policy; it cannot enforce DSH read-only or workspace-write confinement')
    return {
      ...request,
      workdir: request.workdir ?? this.root,
      timeoutMs: Math.min(positiveInteger(request.timeoutMs ?? this.defaultTimeout, 'timeoutMs'), this.timeoutCap),
      stdoutMaxBytes: Math.min(positiveInteger(request.stdoutMaxBytes ?? this.defaultOutput, 'stdoutMaxBytes'), this.outputCap),
      sandboxPolicy: policy,
    }
  }

  override run(input: ShellExecSpec): Promise<ShellRunResult> {
    let spec: ShellExecSpec
    try { spec = this.resolve(input) } catch (error) { return Promise.reject(error) }
    if (spec.signal?.aborted) return Promise.reject(new HarnessError('Command aborted before dispatch; no command was sent', 'TOOL_ABORTED'))
    const controller = new AbortController()
    const signal = spec.signal ? AbortSignal.any([spec.signal, controller.signal]) : controller.signal
    let deadlineExpired = false
    const timer = setTimeout(() => {
      if (!signal.aborted) { deadlineExpired = true; controller.abort() }
    }, spec.timeoutMs)
    const work = this.execute(spec, signal, () => deadlineExpired)
    this.active.set(controller, work)
    void work.finally(() => { clearTimeout(timer); this.active.delete(controller) }).catch(() => {})
    return work
  }

  private async execute(spec: ShellExecSpec, signal: AbortSignal, deadlineExpired: () => boolean): Promise<ShellRunResult> {
    const fs = this.filesystem
    const target = await fs.resolve(spec.workdir, { cwd: this.root, signal })
    const processPath = fs.processPath(target)
    if (!(await stat(processPath)).isDirectory()) throw fail('INVALID_REQUEST', 'workdir must be an existing workspace directory')
    const cwd = posix.relative(this.root, processPath) || '.'
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (!key.startsWith('DSH_')) env[key] = value
    }
    for (const [key, value] of Object.entries(spec.dshEnv ?? {})) {
      if (!key.startsWith('DSH_')) throw fail('INVALID_REQUEST', 'Managed environment keys must start with DSH_')
      env[key] = value
    }
    for (const [key, value] of Object.entries(env)) {
      if (!key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) throw fail('INVALID_REQUEST', 'Invalid command environment entry')
    }
    if (signal.aborted) throw new HarnessError('Command aborted before dispatch; no command was sent', 'TOOL_ABORTED')
    const stdout = new OutputTail(spec.stdoutMaxBytes)
    const stderr = new OutputTail(this.defaultOutput)
    let executionId = ''
    const result = (exitCode: number, timedOut = false, aborted = false): ShellRunResult => ({
      exitCode, signal: null, timedOut, aborted, timeoutMs: spec.timeoutMs,
      stdout: stdout.result(), stderr: stderr.result(),
      sandbox: { mode: 'danger-full-access', denied: false },
    })
    try {
      const completed = await this.client.exec({
        argv: ['bash', '-c', spec.command], cwd, env,
        workspace: { root: fs.config.remoteRoot }, timeout_ms: spec.timeoutMs,
      }, {
        signal,
        onStarted: started => { executionId = started.executionId },
        onStdout: chunk => stdout.append(chunk),
        onStderr: chunk => stderr.append(chunk),
      })
      return result(completed.exitCode)
    } catch (error) {
      if (error instanceof RuntimeTimeoutError) return result(124, true)
      if (error instanceof RuntimeCanceledError) return deadlineExpired() ? result(124, true) : result(130, false, true)
      if ((error instanceof RuntimeExecutionError || error instanceof RuntimeOutcomeUnknownError) && error.executionId) executionId = error.executionId
      let code = 'FAILED'
      if (error instanceof RuntimeBusyError) code = 'BUSY'
      else if (error instanceof RuntimeNotEnabledError) code = 'UNAVAILABLE'
      else if (error instanceof RuntimeOutcomeUnknownError || !(error instanceof RuntimeExecutionError)) code = 'OUTCOME_UNKNOWN'
      else if (error instanceof RuntimeStartError) code = error.code === 'unavailable' ? 'UNAVAILABLE' : 'START_FAILED'
      else if (error.code === 'engine_error') code = 'ENGINE_ERROR'
      const caution = code === 'OUTCOME_UNKNOWN' ? ' Remote stop is unconfirmed; inspect before retrying.' : ''
      throw fail(code, `Runtime ${code}; execution_id=${executionId || '(not received)'}.${caution}\n${error instanceof Error ? error.message : 'Execution failed'}\nstdout tail: ${JSON.stringify(stdout.result())}\nstderr tail: ${JSON.stringify(stderr.result())}`)
    }
  }

  override start(_spec: ShellExecSpec): ShellProcess {
    throw fail('UNSUPPORTED', 'Runtime shell supports foreground commands only; background jobs and PTY are unavailable')
  }

  /** Stop admission and await confirmed completion/cancellation, with a fixed bound. */
  close(): Promise<void> {
    this.closePromise ??= this.drain()
    return this.closePromise
  }

  private async drain(): Promise<void> {
    this.closing = true
    const pending = [...this.active.entries()]
    for (const [controller] of pending) controller.abort()
    const results = await bounded(Promise.allSettled(pending.map(([, work]) => work)), SHUTDOWN_TIMEOUT_MS,
      () => fail('OUTCOME_UNKNOWN', 'Runtime shutdown exceeded 25 seconds; remote stop is unconfirmed'))
    for (const result of results) {
      if (result.status === 'rejected' && result.reason instanceof HarnessError && result.reason.code === 'DRIVE9_EXEC_OUTCOME_UNKNOWN') throw result.reason
    }
  }
}

export default Drive9Shell
