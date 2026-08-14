import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import {
  CallId,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { Drive9EvidenceStore } from '../src/evidence.js'
import type { Drive9EvidenceConfig } from '../src/evidence.js'
import { Drive9FileSystem } from '../src/filesystem.js'
import type { Drive9FileSystemConfig } from '../src/filesystem.js'
import resultTools from '../src/result-tools.js'
import { FakeDrive9Client } from './fake-drive9.js'

const execFileAsync = promisify(execFile)
const RESULT_ID = /drive9-result:v1:[A-Za-z0-9_-]{43}/u

type ScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[])

function toolCall(callId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(callId)
  const serialized = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function resultIdFrom(options: GenerateOptions): string {
  const match = JSON.stringify(options.messages).match(RESULT_ID)
  if (match?.[0] === undefined) throw new Error('script expected a Drive9 result_id in model history')
  return match[0]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

function toolResultText(agent: Agent, callId: string): string {
  const event = agent.session.events.find(candidate => candidate.type === 'tool/result'
    && candidate.data.message.content[0].type === 'tool-result'
    && String(candidate.data.message.content[0].toolCallId) === callId)
  if (event?.type !== 'tool/result') return ''
  const block = event.data.message.content[0]
  if (block.type !== 'tool-result') return ''
  return block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('')
}

let context: Context | undefined
let mountRoot: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (mountRoot !== undefined) await rm(mountRoot, { recursive: true, force: true })
  mountRoot = undefined
})

describe('real DeepSeek Harness agent loop', () => {
  it('writes through fs tools, exposes mount bytes to a process, and retrieves spilled evidence', async () => {
    mountRoot = await mkdtemp(join(tmpdir(), 'drive9-dsh-agent-loop-'))
    const workspace = new FakeDrive9Client({ mountRoot, remoteRoot: '/workspace' })
    workspace.mkdirRecord('/workspace')
    const evidence = new FakeDrive9Client()
    evidence.mkdirRecord('/evidence/dsh')

    class TestWorkspace extends Drive9FileSystem {
      constructor(ctx: Context, config: Drive9FileSystemConfig) {
        super(ctx, config, () => workspace)
      }
    }
    class TestEvidence extends Drive9EvidenceStore {
      constructor(ctx: Context, config: Drive9EvidenceConfig) {
        super(ctx, config, () => evidence)
      }
    }

    const adapter = new ScriptedAdapter([
      toolCall('write-call', 'write', { file_path: 'note.txt', content: 'written by the model\n' }),
      toolCall('process-call', 'process_read', { file_path: 'note.txt' }),
      toolCall('huge-call', 'huge_log', {}),
      options => toolCall('search-call', 'result_search', {
        result_id: resultIdFrom(options),
        query: 'FATAL integration marker',
        max_matches: 2,
        context_lines: 1,
      }),
      options => toolCall('read-call', 'result_read', {
        result_id: resultIdFrom(options),
        offset: 39,
        limit: 3,
      }),
      textResponse('Drive9 workspace and evidence verified.'),
    ])

    context = new Context()
    await mountAgentLoopTestDependencies(context, {
      systemPrompt: { persona: 'Use the available tools to verify the Drive9 integration.' },
    })
    await context.plugin(AgentLoop, { agents: [] })
    context.llm.registerAdapter(['scripted'], adapter)
    await context.plugin(TestWorkspace, {
      mountRoot,
      remoteRoot: '/workspace',
      apiKey: 'workspace-key',
      coherenceTimeoutMs: 500,
      coherencePollMs: 2,
    })
    await context.plugin(FsPolicy)
    await context.plugin(ToolFs)
    await context.plugin(TestEvidence, { root: '/evidence/dsh', apiKey: 'evidence-key' })
    await context.plugin(SpillPolicy, { maxInlineBytes: 1024 })
    await context.plugin(resultTools, { maxScanBytes: 1024 * 1024 })

    context.tools.register(defineContentToolFixture({
      name: 'process_read',
      description: 'Read one workspace file through a real subprocess path.',
      parameters: { file_path: { type: 'string', required: true } },
      async execute(args) {
        const target = await context!.fs.resolve(args.file_path)
        const { stdout } = await execFileAsync('/bin/cat', [context!.fs.processPath(target)], { encoding: 'utf8' })
        return [{ type: 'text', text: stdout }]
      },
    }))
    context.tools.register(defineContentToolFixture({
      name: 'huge_log',
      description: 'Return a large deterministic diagnostic log.',
      parameters: {},
      async execute() {
        const lines = Array.from({ length: 80 }, (_, index) => index === 40
          ? 'FATAL integration marker: database unavailable'
          : `diagnostic line ${index + 1}: ${'x'.repeat(48)}`)
        return [{ type: 'text', text: `${lines.join('\n')}\n` }]
      },
    }))

    const agent = context.agentLoop.create(SessionId('drive9-agent-loop-e2e'), {
      provider: 'scripted',
      model: 'scripted',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Verify workspace and evidence end to end.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(await readFile(join(mountRoot, 'note.txt'), 'utf8')).toBe('written by the model\n')
    expect(Buffer.from(workspace.getFile('/workspace/note.txt') ?? []).toString('utf8')).toBe('written by the model\n')
    expect(toolResultText(agent, 'process-call')).toContain('written by the model')
    const locator = toolResultText(agent, 'huge-call').match(RESULT_ID)?.[0]
    expect(locator).toBeDefined()
    expect(Buffer.byteLength(toolResultText(agent, 'huge-call'), 'utf8')).toBeLessThanOrEqual(1024)
    expect(toolResultText(agent, 'search-call')).toContain('FATAL integration marker')
    expect(toolResultText(agent, 'read-call')).toContain('FATAL integration marker')
    expect([...evidence.nodes.keys()].filter(path => path.includes('/manifests/') && path.endsWith('.json'))).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([
      'write', 'process_read', 'huge_log', 'result_search', 'result_read',
    ])
    expect(adapter.requests).toHaveLength(6)

    await execFileAsync('/bin/rm', [join(mountRoot, 'note.txt')])
    await expect(readFile(join(mountRoot, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await (context.spillStore as Drive9EvidenceStore).readPublished(locator!, 1024 * 1024)).content)
      .toContain('FATAL integration marker')
  })
})
