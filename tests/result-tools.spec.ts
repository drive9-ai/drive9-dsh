import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { Drive9EvidenceStore } from '../src/evidence.js'
import * as resultTools from '../src/result-tools.js'
import {
  HARD_MAX_RETURN_BYTES,
  HARD_MAX_RETURN_LINES,
  HARD_MAX_SCAN_BYTES,
  HARD_MAX_SEARCH_MATCHES,
} from '../src/result-tools.js'
import type { Drive9ResultToolsConfig } from '../src/result-tools.js'
import { FakeDrive9Client } from './fake-drive9.js'

function issuingEvents(callId: string, toolName: string, retrievalHint: string): SessionEvent[] {
  return [
    {
      type: 'tool/call', seq: 0, time: 0,
      data: { turn: 1, step: 1, callId: CallId(callId), name: toolName, arguments: '{}' },
      surfaceOp: 'append',
    },
    {
      type: 'tool/result', seq: 1, time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-1', role: 'user', source: { kind: 'tool', toolName },
          content: [{
            type: 'tool-result', toolCallId: CallId(callId),
            content: [{ type: 'text', text: `preview\n${retrievalHint}` }],
          }],
        },
      },
      surfaceOp: 'append',
    },
  ] as unknown as SessionEvent[]
}

function mockAgent(sessionId: string, events: SessionEvent[]): Agent {
  const session = {
    header: { version: 1, id: SessionId(sessionId), createdAt: 0 },
    events,
  } as unknown as Session
  return { session } as unknown as Agent
}

const SMALL_LIMITS: Drive9ResultToolsConfig = {
  maxReturnLines: 5,
  maxReturnBytes: 1024,
  maxSearchMatches: 3,
  maxScanBytes: 4096,
}

async function setup(config: Drive9ResultToolsConfig = SMALL_LIMITS) {
  const client = new FakeDrive9Client()
  client.mkdirRecord('/evidence/dsh')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  class TestEvidenceStore extends Drive9EvidenceStore {
    constructor(inner: Context) {
      super(inner, { root: '/evidence/dsh', apiKey: 'evidence-key' }, () => client)
    }
  }
  await ctx.plugin(TestEvidenceStore, { apiKey: 'evidence-key' })
  await ctx.plugin(resultTools, config)
  return { ctx, store: ctx.spillStore as Drive9EvidenceStore }
}

async function execute(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`retrieve-${name}`),
    name,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
}

describe('Drive9 result tools', () => {
  it('reads and searches only an issued exact locator with bounded output', async () => {
    const { ctx, store } = await setup()
    const ref = await store.saveText({
      owner: { sessionId: SessionId('current') },
      source: { toolName: 'exec', callId: CallId('source-call'), label: 'result' },
      suggestedName: 'exec.txt',
      content: 'alpha\nFAILED first\nbeta\nFAILED second\nomega\n',
    })
    const agent = mockAgent('current', issuingEvents('source-call', 'exec', ref.retrievalHint))

    const read = await execute(ctx, 'result_read', { result_id: ref.locator, offset: 1, limit: 2 }, agent)
    expect(read.isError).toBe(false)
    expect(read.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('L2: FAILED first') })

    const search = await execute(ctx, 'result_search', {
      result_id: ref.locator,
      query: 'failed',
      max_matches: 2,
      context_lines: 0,
    }, agent)
    expect(search.isError).toBe(false)
    expect(search.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('FAILED second') })
  })

  it('fails closed without an agent or issued receipt', async () => {
    const { ctx, store } = await setup()
    const ref = await store.saveText({
      owner: { sessionId: SessionId('current') },
      source: { toolName: 'exec', callId: CallId('source-call'), label: 'result' },
      suggestedName: 'exec.txt',
      content: 'secret',
    })
    const noAgent = await execute(ctx, 'result_read', { result_id: ref.locator })
    expect(noAgent).toMatchObject({ isError: true, error: { info: { code: 'DRIVE9_RESULT_UNAUTHORIZED' } } })
    const unissued = await execute(ctx, 'result_read', { result_id: ref.locator }, mockAgent('current', []))
    expect(unissued).toMatchObject({ isError: true, error: { info: { code: 'DRIVE9_RESULT_UNAUTHORIZED' } } })
  })

  it('rejects malformed ids and hard-limit violations', async () => {
    const { ctx } = await setup()
    const agent = mockAgent('current', [])
    const malformed = await execute(ctx, 'result_read', { result_id: 'bad' }, agent)
    expect(malformed).toMatchObject({ isError: true, error: { info: { code: 'DRIVE9_RESULT_INVALID_ID' } } })
    const query = await execute(ctx, 'result_search', {
      result_id: 'bad',
      query: 'x'.repeat(65 * 1024),
    }, agent)
    expect(query).toMatchObject({ isError: true, error: { info: { code: 'DRIVE9_RESULT_SCAN_LIMIT' } } })
  })

  it('enforces the public hard ceilings and the default 64 KiB output cap', async () => {
    const invalidConfigs: Drive9ResultToolsConfig[] = [
      { maxReturnLines: HARD_MAX_RETURN_LINES + 1 },
      { maxReturnBytes: HARD_MAX_RETURN_BYTES + 1 },
      { maxSearchMatches: HARD_MAX_SEARCH_MATCHES + 1 },
      { maxScanBytes: HARD_MAX_SCAN_BYTES + 1 },
    ]
    for (const config of invalidConfigs) {
      expect(() => resultTools.apply(new Context(), config)).toThrow(/must be an integer between/)
    }

    const { ctx, store } = await setup({})
    const content = `${Array.from({ length: HARD_MAX_RETURN_LINES }, () => 'x'.repeat(200)).join('\n')}\n`
    const ref = await store.saveText({
      owner: { sessionId: SessionId('current') },
      source: { toolName: 'exec', callId: CallId('source-call'), label: 'result' },
      suggestedName: 'large.txt',
      content,
    })
    const agent = mockAgent('current', issuingEvents('source-call', 'exec', ref.retrievalHint))

    const read = await execute(ctx, 'result_read', {
      result_id: ref.locator,
      offset: 0,
      limit: HARD_MAX_RETURN_LINES,
    }, agent)
    expect(read.isError).toBe(false)
    expect(Buffer.byteLength(read.content[0]?.type === 'text' ? read.content[0].text : '', 'utf8'))
      .toBeLessThanOrEqual(HARD_MAX_RETURN_BYTES)

    const tooManyLines = await execute(ctx, 'result_read', {
      result_id: ref.locator,
      limit: HARD_MAX_RETURN_LINES + 1,
    }, agent)
    expect(tooManyLines).toMatchObject({ isError: true, error: { info: { code: 'DRIVE9_RESULT_SCAN_LIMIT' } } })

    const tooManyMatches = await execute(ctx, 'result_search', {
      result_id: ref.locator,
      query: 'x',
      max_matches: HARD_MAX_SEARCH_MATCHES + 1,
    }, agent)
    expect(tooManyMatches).toMatchObject({ isError: true, error: { info: { code: 'DRIVE9_RESULT_SCAN_LIMIT' } } })
  })
})
