import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { Client } from 'drive9'
import { afterEach, expect, it, vi } from 'vitest'
import { Drive9Shell } from '../src/shell.js'
import { shellFixture } from './shell-fixture.js'
import { runtimeProtocolFixture } from './runtime-protocol-fixture.js'
import { ScriptedAdapter, toolCall, textResponse, toolResultText } from './agent-fixture.js'

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<object>(), platform: () => 'linux' }))
let f: Awaited<ReturnType<typeof shellFixture>> | undefined
let protocol: Awaited<ReturnType<typeof runtimeProtocolFixture>> | undefined
afterEach(async () => { await f?.cleanup(); await protocol?.close(); f = undefined; protocol = undefined })

it('standard bash and filesystem tools share bytes through the published SDK and HTTP protocol', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  f = await shellFixture('danger-full-access', ctx)
  protocol = await runtimeProtocolFixture(f.root, f.caps)
  const sdk = new Client(protocol.url, 'fixture-workspace')
  const evidenceSDK = new Client(protocol.url, 'fixture-evidence')
  f.workspace.exec = sdk.exec.bind(sdk)
  f.workspace.runtimeCapabilities = () => sdk.runtimeCapabilities()
  f.workspace.status = async () => ({ tenant_id: String((await sdk.status()).tenant_id) })
  f.evidence.status = async () => ({ tenant_id: String((await evidenceSDK.status()).tenant_id) })
  const shell = await f.mount()
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolBash, { enableRunInBackground: false })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  const adapter = new ScriptedAdapter([
    toolCall('write', 'write', { file_path: 'note.txt', content: 'hello from fs\n' }),
    toolCall('bash', 'bash', { workdir: f.root, command: 'a=(Bash works); cat note.txt; printf "%s" "${a[1]}" > result.txt; printf error >&2', description: 'Read and write shared files' }),
    toolCall('read', 'read', { file_path: 'result.txt' }),
    toolCall('engine', 'bash', { workdir: f.root, command: '__fixture_engine_error__', description: 'Exercise executor error' }),
    toolCall('background', 'bash', { command: 'echo forbidden', description: 'Rejected background call', run_in_background: true }),
    textResponse('done'),
    toolCall('denied', 'bash', { workdir: f.root, command: 'echo not dispatched', description: 'Verify current session policy' }),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = ctx.agentLoop.create(SessionId('runtime-loop'), { provider: 'scripted', model: 'scripted' }, { cwd: f.root })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Test Runtime.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(toolResultText(agent, 'bash')).toContain('hello from fs')
  expect(toolResultText(agent, 'bash')).toContain('[stderr]\nerror')
  expect(toolResultText(agent, 'read')).toContain('works')
  expect(toolResultText(agent, 'engine')).toContain('DRIVE9_EXEC_ENGINE_ERROR')
  expect(toolResultText(agent, 'engine')).toContain('partial-output')
  expect(toolResultText(agent, 'background')).toMatch(/background.*disabled|not available|unknown.*run_in_background/is)
  expect(protocol.requests).toHaveLength(2)
  expect(protocol.requests[0]!.argv!.slice(0, 2)).toEqual(['bash', '-c'])
  expect(Buffer.from(await f.workspace.read(f.remoteRoot + '/result.txt')).toString()).toBe('works')
  expect(ctx.shell instanceof Drive9Shell).toBe(true)

  setSandboxMode(agent.session, 'read-only')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try with changed permissions.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(toolResultText(agent, 'denied')).toContain('DRIVE9_EXEC_POLICY_DENIED')
  expect(protocol.requests).toHaveLength(2)
})

it('published SDK obtains HTTP cancellation confirmation before reporting aborted', async () => {
  f = await shellFixture()
  protocol = await runtimeProtocolFixture(f.root, f.caps)
  const sdk = new Client(protocol.url, 'fixture-workspace')
  const controller = new AbortController()
  f.workspace.exec = (request, options) => sdk.exec(request, {
    ...options,
    onStdout: async chunk => { await options?.onStdout?.(chunk); controller.abort() },
  })
  const shell = await f.mount()
  const result = await shell.run(shell.resolve({ command: 'echo ready; sleep 30', signal: controller.signal }))
  expect(result).toMatchObject({ exitCode: 130, timedOut: false, aborted: true })
  expect(result.stdout.text).toContain('ready')
  expect(protocol.cancelCount).toBe(1)
})
