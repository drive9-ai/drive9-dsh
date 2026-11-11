import { Context, Service } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ExecOptions, ExecRequest, ExecResult, RuntimeCapabilities } from 'drive9'
import { Drive9FileSystem, type Drive9FileSystemConfig } from '../src/filesystem.js'
import { Drive9EvidenceStore, type Drive9EvidenceConfig } from '../src/evidence.js'
import { Drive9Shell, type Drive9ShellConfig } from '../src/shell.js'
import { FakeDrive9Client } from './fake-drive9.js'

export async function shellFixture(mode: SandboxMode = 'danger-full-access', context = new Context()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-runtime-')))
  const remoteRoot = '/' + basename(root)
  const caps: RuntimeCapabilities = {
    version: 2, provider: 'fixture', persistence: 'filesystem', workspace_path: dirname(root), user: 'fixture',
    streaming: true, cancel: true, heartbeat_ms: 1000, default_timeout_ms: 60_000, max_timeout_ms: 300_000,
    max_output_bytes: 2 * 1024 * 1024, max_active_per_tenant: 1, warm_sandbox_idle_ms: 60_000,
  }
  const calls: ExecRequest[] = []
  const workspace = Object.assign(new FakeDrive9Client({ mountRoot: root, remoteRoot }), {
    status: async (): Promise<{ tenant_id: string }> => ({ tenant_id: 'workspace-tenant' }),
    runtimeCapabilities: async () => caps,
    exec: async (request: ExecRequest, _options?: ExecOptions): Promise<ExecResult> => {
      calls.push(request)
      return { executionId: 'rex_fixture', exitCode: 0, durationMs: 1, sandbox: 'new' }
    },
  })
  const evidence = Object.assign(new FakeDrive9Client(), {
    status: async (): Promise<{ tenant_id: string }> => ({ tenant_id: 'evidence-tenant' }),
  })
  evidence.mkdirRecord('/evidence/dsh')
  class Workspace extends Drive9FileSystem {
    constructor(ctx: Context, config: Drive9FileSystemConfig) { super(ctx, config, () => workspace) }
  }
  class Evidence extends Drive9EvidenceStore {
    constructor(ctx: Context, config: Drive9EvidenceConfig) { super(ctx, config, () => evidence) }
  }
  class TestShell extends Drive9Shell {
    async initializeForTest() { await this[Service.init]() }
  }
  await context.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
  await context.plugin(Workspace, { mountRoot: root, remoteRoot, apiKey: 'fixture-workspace', coherenceTimeoutMs: 500, coherencePollMs: 2 })
  await context.plugin(Evidence, { apiKey: 'fixture-evidence' })
  let shell: TestShell | undefined
  return {
    root, remoteRoot, caps, calls, workspace, evidence, context,
    async mount(config: Drive9ShellConfig = {}): Promise<Drive9Shell> {
      shell = new TestShell(context, config)
      await shell.initializeForTest()
      return shell
    },
    async cleanup() {
      await shell?.close().catch(() => {})
      await context.fiber.dispose()
      await rm(root, { force: true, recursive: true })
    },
  }
}
