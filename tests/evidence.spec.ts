import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { describe, expect, it } from 'vitest'
import { Drive9EvidenceStore } from '../src/evidence.js'
import { extractReceipts } from '../src/receipt.js'
import { FakeDrive9Client, FakeStatusError } from './fake-drive9.js'

function input(overrides: Partial<SaveTextSpill> = {}): SaveTextSpill {
  return {
    owner: { sessionId: SessionId('session-a') },
    source: { toolName: 'exec', callId: CallId('call-a'), label: 'result' },
    suggestedName: 'exec.txt',
    content: 'alpha\nFAILED test\nomega\n',
    ...overrides,
  }
}

function setup() {
  const client = new FakeDrive9Client()
  client.mkdirRecord('/evidence/dsh')
  const store = new Drive9EvidenceStore(new Context(), {
    root: '/evidence/dsh',
    apiKey: 'evidence-key',
  }, () => client)
  return { client, store }
}

describe('Drive9EvidenceStore', () => {
  it('rejects reuse of the workspace credential', () => {
    expect(() => new Drive9EvidenceStore(new Context(), {
      root: '/evidence/dsh',
      apiKey: 'same-key',
      workspaceApiKey: 'same-key',
    })).toThrow('workspace and evidence must use different scoped credentials')
  })

  it('publishes content before an immutable manifest and returns a verifiable receipt', async () => {
    const { store } = setup()
    await store.initialize()
    const ref = await store.saveText(input())
    expect(ref.bytes).toBe(Buffer.byteLength(input().content, 'utf8'))
    const receipts = extractReceipts(ref.retrievalHint)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      locator: ref.locator,
      sessionId: 'session-a',
      toolName: 'exec',
      callId: 'call-a',
    })

    const published = await store.readPublished(ref.locator, 1024)
    expect(published.content).toBe(input().content)
    expect(receipts[0]?.manifestSha256).toBe(published.manifestSha256)
    expect(published.manifest).toMatchObject({
      locator: ref.locator,
      bytes: ref.bytes,
      sessionId: 'session-a',
      toolName: 'exec',
      callId: 'call-a',
    })
  })

  it('publishes no locator when manifest creation fails', async () => {
    const { client, store } = setup()
    await store.initialize()
    client.beforeWrite = (path) => {
      if (path.includes('/manifests/')) throw new FakeStatusError('manifest backend down', 503)
    }
    await expect(store.saveText(input())).rejects.toMatchObject({ code: 'DRIVE9_RESULT_IO' })
    expect([...client.nodes].filter(([path]) => path.includes('/objects/') && path.endsWith('.txt'))).toHaveLength(1)
    expect([...client.nodes].filter(([path]) => path.includes('/manifests/') && path.endsWith('.json'))).toHaveLength(0)
  })

  it('publishes no locator or manifest when content creation fails', async () => {
    const { client, store } = setup()
    await store.initialize()
    client.beforeWrite = (path) => {
      if (path.includes('/objects/')) throw new FakeStatusError('content backend down', 503)
    }
    await expect(store.saveText(input())).rejects.toMatchObject({ code: 'DRIVE9_RESULT_IO' })
    expect([...client.nodes].filter(([path]) => path.endsWith('.txt') || path.endsWith('.json'))).toHaveLength(0)
  })

  it('rejects invalid Unicode and oversized metadata before publishing content', async () => {
    const { client, store } = setup()
    await store.initialize()
    await expect(store.saveText(input({ content: '\ud800' }))).rejects.toMatchObject({ code: 'DRIVE9_RESULT_IO' })
    await expect(store.saveText(input({ suggestedName: 'x'.repeat(70 * 1024) }))).rejects.toMatchObject({
      code: 'DRIVE9_RESULT_IO',
    })
    expect([...client.nodes].filter(([path]) => path.includes('/objects/') && path.endsWith('.txt'))).toHaveLength(0)
  })

  it('fails closed for malformed, missing, oversized, and corrupt evidence', async () => {
    const { client, store } = setup()
    await store.initialize()
    await expect(store.readPublished('not-a-result', 1024)).rejects.toMatchObject({ code: 'DRIVE9_RESULT_INVALID_ID' })
    await expect(store.readPublished(`drive9-result:v1:${'a'.repeat(43)}`, 1024)).rejects.toMatchObject({ code: 'DRIVE9_RESULT_NOT_FOUND' })

    const ref = await store.saveText(input())
    await expect(store.readPublished(ref.locator, 4)).rejects.toMatchObject({ code: 'DRIVE9_RESULT_SCAN_LIMIT' })
    const published = await store.readPublished(ref.locator, 1024)
    client.setFile(published.manifest.contentPath, 'tampered')
    await expect(store.readPublished(ref.locator, 1024)).rejects.toMatchObject({ code: 'DRIVE9_RESULT_CORRUPT' })

    const second = await store.saveText(input({ source: { toolName: 'exec', callId: CallId('call-b'), label: 'result' } }))
    const secondPublished = await store.readPublished(second.locator, 1024)
    const capability = secondPublished.manifest.capability
    client.setFile(`/evidence/dsh/manifests/${capability.slice(0, 2)}/${capability}.json`, '{}')
    await expect(store.readPublished(second.locator, 1024)).rejects.toMatchObject({ code: 'DRIVE9_RESULT_CORRUPT' })
  })

  it('honors an aborted result read before publishing content', async () => {
    const { store } = setup()
    await store.initialize()
    const ref = await store.saveText(input())
    const controller = new AbortController()
    controller.abort()
    await expect(store.readPublished(ref.locator, 1024, controller.signal)).rejects.toMatchObject({
      code: 'DRIVE9_RESULT_ABORTED',
    })
  })

  it('keeps evidence readable after the workspace storage is deleted', async () => {
    const { store } = setup()
    await store.initialize()
    const ref = await store.saveText(input())
    const workspace = new FakeDrive9Client()
    workspace.mkdirRecord('/workspace')
    workspace.setFile('/workspace/file.txt', 'ephemeral')
    await workspace.delete('/workspace/file.txt')
    expect((await store.readPublished(ref.locator, 1024)).content).toContain('FAILED')
  })
})
