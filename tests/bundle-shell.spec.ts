import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { interpolate, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { Context } from '@deepseek-ai/cordis'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { afterEach, expect, it, vi } from 'vitest'
import { Drive9Shell } from '../src/shell.js'
import { shellFixture } from './shell-fixture.js'

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<object>(), platform: () => 'linux' }))
let fixture: Awaited<ReturnType<typeof shellFixture>> | undefined
afterEach(async () => { await fixture?.cleanup(); fixture = undefined })

it.each([false, true])('composes the shipped patch with exactly one shell (Runtime=%s)', async enabled => {
  const base = load(await readFile(new URL('./fixtures/base-shell.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as EntryOptions[]
  const patch = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  const warn = vi.fn()
  const composed = applyEntryPatches(base, patch, warn)
  const rows = interpolate({ process: { platform: 'linux', env: enabled ? { DRIVE9_EXEC: 'true' } : {} } }, composed) as EntryOptions[]
  expect(warn).not.toHaveBeenCalled()
  expect(rows.filter(row => !row.disabled && row.name.match(/bash-sandbox|pwsh-sandbox|drive9-dsh\/shell/u))).toHaveLength(1)
  expect(rows.some(row => row.id === 'sandbox-policy')).toBe(false)

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fixture = await shellFixture('read-only', ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  // This test never requests host confinement; the stock provider still requires the seam.
  ctx.provide('sandbox', { confine() { throw new Error('unexpected local confinement') } })
  const shellRow = rows.find(row => !row.disabled && row.name.match(/bash-sandbox|drive9-dsh\/shell/u))!
  if (enabled) await ctx.plugin(Drive9Shell, shellRow.config ?? {})
  else await ctx.plugin(SandboxBashExecutor, shellRow.config ?? {})
  expect(ctx.shell instanceof (enabled ? Drive9Shell : SandboxBashExecutor)).toBe(true)
  expect(ctx.shell.sandboxMode).toBe('read-only')
  await ctx.plugin(ShellEnv)
  const toolRow = rows.find(row => row.id === 'tool-bash')!
  await ctx.plugin(ToolBash, toolRow.config)
  expect(toolRow.config.enableRunInBackground).toBe(!enabled)
  // Cordis must reject a second provider instead of silently swapping it.
  await expect(ctx.plugin(enabled ? SandboxBashExecutor : Drive9Shell, {})).rejects.toThrow(/already|duplicate|registered/)
})
