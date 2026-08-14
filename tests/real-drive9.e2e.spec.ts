import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readFile, statfs } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { Drive9EvidenceStore } from '../src/evidence.js'
import { Drive9FileSystem } from '../src/filesystem.js'

const execFileAsync = promisify(execFile)
const LINUX_FUSE_SUPER_MAGIC = 0x65735546
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
    expect(process.platform).toBe('linux')
    const mountFs = await statfs(process.env.DRIVE9_MOUNT_ROOT!)
    expect(mountFs.type).toBe(LINUX_FUSE_SUPER_MAGIC)

    const baseUrl = process.env.DRIVE9_BASE_URL!
    const workspace = new Drive9FileSystem(new Context(), {
      baseUrl,
      apiKey: process.env.DRIVE9_WORKSPACE_API_KEY!,
      mountRoot: process.env.DRIVE9_MOUNT_ROOT!,
      remoteRoot: process.env.DRIVE9_REMOTE_ROOT!,
      mountConsistency: 'strong',
      verifyCoherence: true,
    })
    const evidence = new Drive9EvidenceStore(new Context(), {
      baseUrl,
      apiKey: process.env.DRIVE9_EVIDENCE_API_KEY!,
      root: process.env.DRIVE9_EVIDENCE_ROOT!,
    })

    const initializeStarted = performance.now()
    await workspace.initialize()
    const workspaceInitializeMs = performance.now() - initializeStarted
    await evidence.initialize()
    const filename = `.drive9-dsh-real-${Date.now()}-${randomUUID()}.txt`
    const target = await workspace.resolve(filename)
    const remotePath = workspace.targets.decode(target).remotePath
    const processPath = workspace.processPath(target)
    const content = `real Drive9 e2e ${randomUUID()}\n`
    try {
      const sdkWriteStarted = performance.now()
      await workspace.writeText(target, content, { kind: 'createIfAbsent' })
      const modelWriteToMountMs = performance.now() - sdkWriteStarted
      expect(await workspace.readText(target)).toBe(content)
      expect(await readFile(processPath, 'utf8')).toBe(content)
      const { stdout } = await execFileAsync('/bin/cat', [processPath], { encoding: 'utf8' })
      expect(stdout).toBe(content)

      const beforeMountWrite = await workspace.client.stat(remotePath)
      const mountedContent = `real Drive9 mount write ${randomUUID()}\n`
      const handle = await open(processPath, 'w')
      await handle.writeFile(mountedContent)
      const closeStarted = performance.now()
      await handle.close()
      const mountCloseMs = performance.now() - closeStarted
      const mountWriteStarted = performance.now()
      let mountRevision = beforeMountWrite.revision
      while (performance.now() - mountWriteStarted < 10_000) {
        const info = await workspace.client.stat(remotePath)
        if (info.revision > beforeMountWrite.revision) {
          const bytes = await workspace.client.read(remotePath)
          if (Buffer.from(bytes).toString('utf8') === mountedContent) {
            mountRevision = info.revision
            break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(mountRevision).toBeGreaterThan(beforeMountWrite.revision)
      const mountCloseToSdkMs = performance.now() - mountWriteStarted

      const ref = await evidence.saveText({
        owner: { sessionId: SessionId(`drive9-real-${Date.now()}`) },
        source: { toolName: 'real_e2e', callId: CallId(randomUUID()), label: 'result' },
        suggestedName: 'real-e2e.txt',
        content: mountedContent,
      })
      const published = await evidence.readPublished(ref.locator, 64 * 1024)
      expect(published.content).toBe(mountedContent)
      expect(published.manifest.locator).toBe(ref.locator)
      console.info('drive9-real-e2e-metrics', JSON.stringify({
        workspaceInitializeMs: Math.round(workspaceInitializeMs),
        modelWriteToMountMs: Math.round(modelWriteToMountMs),
        mountCloseMs: Math.round(mountCloseMs),
        mountCloseToSdkMs: Math.round(mountCloseToSdkMs),
        initialRevision: beforeMountWrite.revision,
        mountRevision,
        mountFsType: `0x${mountFs.type.toString(16)}`,
      }))
    } finally {
      await workspace.client.delete(remotePath).catch(() => undefined)
    }
  }, 60_000)
})
