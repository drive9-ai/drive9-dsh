import { mkdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeBusyError, RuntimeCanceledError, RuntimeExecutionError, RuntimeNotEnabledError, RuntimeOutcomeUnknownError, RuntimeStartError, RuntimeTimeoutError } from 'drive9'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Drive9Shell } from '../src/shell.js'
import { OutputTail } from '../src/shell-output.js'
import { shellFixture } from './shell-fixture.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<object>(), stat: vi.fn((...args: Parameters<typeof stat>) => importOriginal<typeof import('node:fs/promises')>().then(module => module.stat(...args))) }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<object>(), platform: () => 'linux' }))
const fixtures: Awaited<ReturnType<typeof shellFixture>>[] = []
async function setup() { const fixture = await shellFixture(); fixtures.push(fixture); return fixture }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(f => f.cleanup())) })

describe('Drive9 foreground shell', () => {
  it('sends exact Bash argv, root-relative cwd and only explicit managed env', async () => {
    const f = await setup()
    await mkdir(join(f.root, 'sub'))
    const shell = await f.mount()
    await shell.run(shell.resolve({ command: 'a=(one two); printf "%s" "${a[1]}"', workdir: 'sub', env: { NAME: 'value', DSH_STALE: 'ignored' }, dshEnv: { DSH_SESSION_ID: 'current' } }))
    expect(f.calls).toEqual([{ argv: ['bash', '-c', 'a=(one two); printf "%s" "${a[1]}"'], cwd: 'sub', env: { NAME: 'value', DSH_SESSION_ID: 'current' }, workspace: { root: f.remoteRoot }, timeout_ms: 60_000 }])
  })

  it.each([0, 1, 2, 7, 127])('preserves ordinary exit %s without kill flags', async exitCode => {
    const f = await setup()
    f.workspace.exec = async () => ({ executionId: 'rex_fixture', exitCode, durationMs: 1, sandbox: '' })
    const shell = await f.mount()
    expect(await shell.run(shell.resolve({ command: 'grep -a x a' }))).toMatchObject({ exitCode, signal: null, timedOut: false, aborted: false })
  })

  it.each([
    [new RuntimeTimeoutError('stopped', 'rex_fixture'), 124, true, false],
    [new RuntimeCanceledError('stopped', 'rex_fixture'), 130, false, true],
  ] as const)('maps confirmed outcome %s', async (error, exitCode, timedOut, aborted) => {
    const f = await setup(); f.workspace.exec = async () => { throw error }
    const shell = await f.mount()
    expect(await shell.run(shell.resolve({ command: 'sleep 10' }))).toMatchObject({ exitCode, timedOut, aborted, signal: null })
  })

  it.each([
    [new RuntimeExecutionError('engine_error', 'budget exceeded', 'rex_fixture'), 'ENGINE_ERROR'],
    [new RuntimeOutcomeUnknownError('stream lost', 'rex_fixture'), 'OUTCOME_UNKNOWN'],
    [new RuntimeBusyError('busy', 10), 'BUSY'],
    [new RuntimeNotEnabledError(), 'UNAVAILABLE'],
    [new RuntimeStartError('start_failed', 'cannot start'), 'START_FAILED'],
    [new Error('connection reset'), 'OUTCOME_UNKNOWN'],
  ])('keeps infrastructure failure %s distinct from ordinary grep 1', async (error, code) => {
    const f = await setup()
    f.workspace.exec = async (_, options) => {
      options?.onStarted?.({ executionId: 'rex_fixture', cwd: f.root, sandbox: '' })
      options?.onStdout?.(Buffer.from('partial'))
      throw error
    }
    const shell = await f.mount()
    await expect(shell.run(shell.resolve({ command: 'grep -a x a' }))).rejects.toMatchObject({ code: `DRIVE9_EXEC_${code}`, message: expect.stringContaining('partial') })
  })

  it('keeps split UTF-8 and separate bounded tails without fake spill paths', async () => {
    const f = await setup()
    f.workspace.exec = async (_, options) => {
      const bytes = Buffer.from('123你好')
      options?.onStdout?.(bytes.subarray(0, 5)); options?.onStdout?.(bytes.subarray(5))
      options?.onStderr?.(Buffer.from('error-long'))
      return { executionId: 'rex_fixture', exitCode: 0, durationMs: 1, sandbox: '' }
    }
    const shell = await f.mount({ maxOutputBytes: 6 })
    expect(await shell.run(shell.resolve({ command: 'echo' }))).toMatchObject({ stdout: { text: '你好', truncated: true }, stderr: { text: 'r-long', truncated: true } })
    const tail = new OutputTail(4); tail.append(Buffer.from('你你好'))
    expect(tail.result()).toEqual({ text: '好', truncated: true })
  })

  it('rejects policy changes, stdin and background without dispatch', async () => {
    const f = await setup(); const shell = await f.mount()
    for (const mode of ['read-only', 'workspace-write'] as const) {
      expect(() => shell.resolve({ command: 'echo', sandboxPolicy: { mode, workspaceRoot: f.root } })).toThrow(/cannot enforce/)
    }
    expect(() => shell.resolve({ command: 'echo', stdin: '' })).toThrow(/stdin/)
    expect(() => shell.start(shell.resolve({ command: 'echo' }))).toThrow(/foreground/)
    const spec = shell.resolve({ command: 'echo' }); spec.sandboxPolicy = { mode: 'read-only', workspaceRoot: f.root }
    await expect(shell.run(spec)).rejects.toMatchObject({ code: 'DRIVE9_EXEC_POLICY_DENIED' })
    expect(f.calls).toHaveLength(0)
  })

  it('performs no exec for pre-abort, outside cwd, symlink escape or file cwd', async () => {
    const f = await setup(); const shell = await f.mount()
    const controller = new AbortController(); controller.abort()
    await expect(shell.run(shell.resolve({ command: 'echo', signal: controller.signal }))).rejects.toMatchObject({ code: 'TOOL_ABORTED' })
    await symlink('/', join(f.root, 'escape'))
    await writeFile(join(f.root, 'file'), '')
    for (const workdir of ['..', '/', 'escape', 'file']) await expect(shell.run(shell.resolve({ command: 'echo', workdir }))).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })

  it.each([0, -1, 1.5, NaN, Infinity, '5', true])('rejects invalid numeric override %s', async value => {
    const f = await setup(); const shell = await f.mount()
    for (const field of ['timeoutMs', 'stdoutMaxBytes']) expect(() => shell.resolve({ command: 'echo', [field]: value })).toThrow(/positive safe integer/)
    expect(f.calls).toHaveLength(0)
  })

  it('caps limits by both package and server', async () => {
    const f = await setup(); f.caps.max_timeout_ms = 70_000; f.caps.max_output_bytes = 128
    const shell = await f.mount({ timeoutMs: 90_000, maxOutputBytes: 256 })
    expect(shell.resolve({ command: 'echo', timeoutMs: 999_999, stdoutMaxBytes: 999_999 })).toMatchObject({ timeoutMs: 70_000, stdoutMaxBytes: 128 })
  })

  it.each([
    { cancel: false }, { streaming: false }, { version: 1 }, { workspace_path: '/workspace/../x' },
    { workspace_path: undefined }, { max_output_bytes: 0 }, { max_timeout_ms: NaN },
    { default_timeout_ms: 999_999 }, { max_output_bytes: true },
  ])('rejects malformed capabilities %s', async override => {
    const f = await setup(); Object.assign(f.caps, override)
    await expect(f.mount()).rejects.toThrow()
  })

  it.each(['workspace-tenant', ''])('rejects evidence tenant %s despite different keys', async tenant_id => {
    const f = await setup(); f.evidence.status = async () => ({ tenant_id })
    await expect(f.mount()).rejects.toThrow(/different authenticated/)
  })

  it('rejects failed identity lookup and wrong namespace', async () => {
    const f = await setup(); f.evidence.status = async () => { throw new Error('status unavailable') }
    await expect(f.mount()).rejects.toThrow(/status unavailable/)
    const g = await setup(); g.caps.workspace_path = '/workspace'
    await expect(g.mount()).rejects.toThrow(/mountRoot/)
  })

  it('uses a client deadline and reports timeout only after cancellation confirmation', async () => {
    const f = await setup()
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    f.workspace.exec = async (_, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new RuntimeCanceledError('confirmed stopped', 'rex_fixture')), { once: true }); started()
    })
    const shell = await f.mount(); vi.useFakeTimers()
    const run = shell.run(shell.resolve({ command: 'sleep 1', timeoutMs: 100 }))
    await ready; await vi.advanceTimersByTimeAsync(100)
    expect(await run).toMatchObject({ exitCode: 124, timedOut: true, aborted: false })
  })

  it.each([['resolve', 'deadline'], ['stat', 'deadline'], ['resolve', 'caller'], ['stat', 'caller']] as const)('bounds a blocked %s before exec on %s and never dispatches late', async (operation, cause) => {
    const f = await setup(); const shell = await f.mount()
    const originalResolve = f.context.fs.resolve.bind(f.context.fs)
    const target = await originalResolve(f.root)
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve })
    if (operation === 'resolve') vi.spyOn(f.context.fs, 'resolve').mockImplementationOnce(async () => { entered(); await blocked; return target })
    else {
      const realInfo = await stat(f.root)
      vi.mocked(stat).mockImplementationOnce(async () => { entered(); await blocked; return realInfo })
    }
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = expect(shell.run(shell.resolve({ command: 'must not execute', timeoutMs: 100, signal: controller.signal }))).rejects.toMatchObject({ code: cause === 'deadline' ? 'DRIVE9_EXEC_START_FAILED' : 'TOOL_ABORTED', message: expect.stringContaining('no command was sent') })
    await ready
    if (cause === 'caller') controller.abort()
    else await vi.advanceTimersByTimeAsync(100)
    await run
    await shell.close()
    release(); await Promise.resolve(); await Promise.resolve()
    expect(f.calls).toHaveLength(0)
  })

  it('closes admission, waits for cancellation, and preserves a normal terminal race', async () => {
    const f = await setup()
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    f.workspace.exec = async (_, options) => new Promise(resolve => {
      options!.signal!.addEventListener('abort', () => resolve({ executionId: 'rex_fixture', exitCode: 7, durationMs: 1, sandbox: '' }), { once: true })
      started()
    })
    const shell = await f.mount(); const run = shell.run(shell.resolve({ command: 'sleep 1' }))
    await ready; await shell.close()
    expect(await run).toMatchObject({ exitCode: 7, aborted: false, timedOut: false })
    expect(() => shell.resolve({ command: 'echo' })).toThrow(/closing/)
  })

  it('does not report unknown cancellation as successful shutdown', async () => {
    const f = await setup()
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    f.workspace.exec = async (_, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new RuntimeOutcomeUnknownError('cancel failed', 'rex_fixture')), { once: true }); started()
    })
    const shell = await f.mount(); const run = shell.run(shell.resolve({ command: 'sleep 1' }))
    const outcome = expect(run).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN' })
    await ready; await expect(shell.close()).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN' }); await outcome
  })

  it('actual Cordis plugin disposal cancels and drains an in-flight command', async () => {
    const f = await setup()
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    f.workspace.exec = async (_, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new RuntimeCanceledError('stopped', 'rex_dispose')), { once: true }); started()
    })
    const plugin = f.context.plugin(Drive9Shell)
    await plugin
    const shell = f.context.shell as Drive9Shell
    const run = shell.run(shell.resolve({ command: 'sleep 1' }))
    await ready; await plugin.dispose()
    expect(await run).toMatchObject({ exitCode: 130, aborted: true, timedOut: false })
    expect(() => shell.resolve({ command: 'echo' })).toThrow(/closing/)
  })

  it('retains an already returned unknown outcome across later completion and shutdown', async () => {
    const f = await setup()
    f.workspace.exec = async () => { throw new RuntimeOutcomeUnknownError('lost terminal', 'rex_unknown_before_close') }
    const shell = await f.mount()
    await expect(shell.run(shell.resolve({ command: 'first command' }))).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN' })
    f.workspace.exec = async () => ({ executionId: 'rex_later', exitCode: 0, durationMs: 1, sandbox: '' })
    expect(await shell.run(shell.resolve({ command: 'inspect result' }))).toMatchObject({ exitCode: 0 })
    await expect(shell.close()).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN', message: expect.stringContaining('rex_unknown_before_close') })
    await expect(shell.close()).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN' })
  })

  it('bounds shutdown for an unresponsive SDK and handles its eventual rejection', async () => {
    const f = await setup()
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    let reject!: (reason: Error) => void
    f.workspace.exec = async () => new Promise((_, fail) => { reject = fail; started() })
    const shell = await f.mount(); const run = shell.run(shell.resolve({ command: 'sleep 1' }))
    const outcome = expect(run).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN' })
    await ready; vi.useFakeTimers()
    const closing = expect(shell.close()).rejects.toMatchObject({ code: 'DRIVE9_EXEC_OUTCOME_UNKNOWN' })
    await vi.advanceTimersByTimeAsync(25_000); await closing
    reject(new RuntimeOutcomeUnknownError('late rejection')); await outcome
  })
})
