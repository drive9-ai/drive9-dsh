import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { Drive9EvidenceStore } from '../src/evidence.js'
import { Drive9FileSystem } from '../src/filesystem.js'

const execFileAsync = promisify(execFile)
const requested = process.env.DRIVE9_REAL_E2E === '1'
const requiredEnvironment = [
  'DRIVE9_BASE_URL',
  'DRIVE9_WORKSPACE_API_KEY',
  'DRIVE9_MOUNT_ROOT',
  'DRIVE9_REMOTE_ROOT',
  'DRIVE9_EVIDENCE_API_KEY',
  'DRIVE9_EVIDENCE_ROOT',
] as const
const missing = requiredEnvironment.filter(name => !process.env[name])

if (requested && missing.length > 0) {
  throw new Error(`Drive9 real e2e is missing required environment variables: ${missing.join(', ')}`)
}

describe.skipIf(!requested)('real Drive9 deployment', () => {
  it('proves SDK/mount coherence and publishes verifiable isolated evidence', async () => {
    const baseUrl = process.env.DRIVE9_BASE_URL!
    const workspace = new Drive9FileSystem(new Context(), {
      baseUrl,
      apiKey: process.env.DRIVE9_WORKSPACE_API_KEY!,
      mountRoot: process.env.DRIVE9_MOUNT_ROOT!,
      remoteRoot: process.env.DRIVE9_REMOTE_ROOT!,
      verifyCoherence: true,
    })
    const evidence = new Drive9EvidenceStore(new Context(), {
      baseUrl,
      apiKey: process.env.DRIVE9_EVIDENCE_API_KEY!,
      root: process.env.DRIVE9_EVIDENCE_ROOT!,
    })

    await workspace.initialize()
    await evidence.initialize()
    const filename = `.drive9-dsh-real-${Date.now()}-${randomUUID()}.txt`
    const target = await workspace.resolve(filename)
    const content = `real Drive9 e2e ${randomUUID()}\n`
    try {
      await workspace.writeText(target, content, { kind: 'createIfAbsent' })
      expect(await workspace.readText(target)).toBe(content)
      expect(await readFile(workspace.processPath(target), 'utf8')).toBe(content)
      const { stdout } = await execFileAsync('/bin/cat', [workspace.processPath(target)], { encoding: 'utf8' })
      expect(stdout).toBe(content)

      const ref = await evidence.saveText({
        owner: { sessionId: SessionId(`drive9-real-${Date.now()}`) },
        source: { toolName: 'real_e2e', callId: CallId(randomUUID()), label: 'result' },
        suggestedName: 'real-e2e.txt',
        content,
      })
      const published = await evidence.readPublished(ref.locator, 64 * 1024)
      expect(published.content).toBe(content)
      expect(published.manifest.locator).toBe(ref.locator)
    } finally {
      await workspace.client.delete(workspace.targets.decode(target).remotePath).catch(() => undefined)
    }
  }, 60_000)
})
