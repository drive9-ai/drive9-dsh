import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { isEvidenceAuthorized } from '../src/authorization.js'
import { Drive9EvidenceStore } from '../src/evidence.js'
import { FakeDrive9Client } from './fake-drive9.js'

function eventLog(callId: string, toolName: string, text: string): SessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq: 0,
      time: 0,
      data: { turn: 1, step: 1, callId: CallId(callId), name: toolName, arguments: '{}' },
      surfaceOp: 'append',
    },
    {
      type: 'tool/result',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-1',
          role: 'user',
          source: { kind: 'tool', toolName },
          content: [{
            type: 'tool-result',
            toolCallId: CallId(callId),
            content: [{ type: 'text', text }] as ContentBlock[],
          }],
        },
      },
      surfaceOp: 'append',
    },
  ] as unknown as SessionEvent[]
}

function dispatchEventLog(callId: string, toolName: string, text: string): SessionEvent[] {
  return [{
    type: 'tool/code-dispatch',
    seq: 0,
    time: 0,
    data: {
      rootCallId: CallId('root-call'),
      parentCallId: CallId('root-call'),
      subCallId: CallId(callId),
      name: toolName,
      arguments: {},
      isError: false,
      content: [{ type: 'text', text }] as ContentBlock[],
    },
    surfaceOp: 'none',
  }] as unknown as SessionEvent[]
}

function session(
  id: string,
  events: SessionEvent[],
  options: { parentSession?: string; seedLength?: number } = {},
): Session {
  return {
    header: {
      version: 1,
      id: SessionId(id),
      createdAt: 0,
      ...(options.parentSession !== undefined ? { parentSession: SessionId(options.parentSession) } : {}),
      ...(options.seedLength !== undefined ? { seedLength: options.seedLength } : {}),
    },
    events,
  } as unknown as Session
}

async function artifact(sessionId: string, callId = 'source-call', label: 'result' | 'dispatch' = 'result') {
  const client = new FakeDrive9Client()
  client.mkdirRecord('/evidence/dsh')
  const store = new Drive9EvidenceStore(new Context(), { root: '/evidence/dsh', apiKey: 'evidence-key' }, () => client)
  await store.initialize()
  const ref = await store.saveText({
    owner: { sessionId: SessionId(sessionId) },
    source: { toolName: 'exec', callId: CallId(callId), label },
    suggestedName: 'exec.txt',
    content: 'evidence',
  })
  const published = await store.readPublished(ref.locator, 1024)
  return { ref, published }
}

describe('evidence authorization', () => {
  it('accepts an integration-issued receipt in the current session', async () => {
    const { ref, published } = await artifact('current')
    const current = session('current', eventLog('source-call', 'exec', ref.retrievalHint))
    expect(isEvidenceAuthorized(current, ref.locator, published.manifest, published.manifestSha256)).toBe(true)
  })

  it('accepts a matching code-dispatch receipt and rejects a label mismatch', async () => {
    const { ref, published } = await artifact('current', 'root-call:code:1', 'dispatch')
    const current = session('current', dispatchEventLog('root-call:code:1', 'exec', ref.retrievalHint))
    expect(isEvidenceAuthorized(current, ref.locator, published.manifest, published.manifestSha256)).toBe(true)

    const mislabeled = session('current', eventLog('root-call:code:1', 'exec', ref.retrievalHint))
    expect(isEvidenceAuthorized(mislabeled, ref.locator, published.manifest, published.manifestSha256)).toBe(false)
  })

  it('rejects same-session unissued and plain-text echoed receipts', async () => {
    const { ref, published } = await artifact('current')
    expect(isEvidenceAuthorized(session('current', []), ref.locator, published.manifest, published.manifestSha256)).toBe(false)
    const echoed = session('current', eventLog('echo-call', 'echo', ref.retrievalHint))
    expect(isEvidenceAuthorized(echoed, ref.locator, published.manifest, published.manifestSha256)).toBe(false)
  })

  it('accepts only a seeded direct-parent receipt', async () => {
    const { ref, published } = await artifact('parent')
    const inherited = eventLog('source-call', 'exec', ref.retrievalHint)
    const unseeded = session('child', inherited, { parentSession: 'parent', seedLength: 0 })
    const seeded = session('child', inherited, { parentSession: 'parent', seedLength: inherited.length })
    expect(isEvidenceAuthorized(unseeded, ref.locator, published.manifest, published.manifestSha256)).toBe(false)
    expect(isEvidenceAuthorized(seeded, ref.locator, published.manifest, published.manifestSha256)).toBe(true)
  })

  it('rejects a sibling receipt even when copied into the seed', async () => {
    const { ref, published } = await artifact('sibling')
    const inherited = eventLog('source-call', 'exec', ref.retrievalHint)
    const child = session('child', inherited, { parentSession: 'parent', seedLength: inherited.length })
    expect(isEvidenceAuthorized(child, ref.locator, published.manifest, published.manifestSha256)).toBe(false)
  })
})
