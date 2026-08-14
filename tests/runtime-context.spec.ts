import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import * as runtimeContext from '../src/runtime-context.js'

describe('Drive9 runtime context', () => {
  it('makes eventual mount staleness visible to the model', async () => {
    const context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(runtimeContext, { mountConsistency: 'eventual' })

    const assembly = await context.systemPrompt.assemble()
    expect(renderContextSnapshot(assembly)).toContain('subprocesses may read stale mounted bytes')
    await context.fiber.dispose()
  })

  it('adds no warning to the strong runtime context', async () => {
    const context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(runtimeContext, { mountConsistency: 'strong' })

    expect(renderContextSnapshot(await context.systemPrompt.assemble())).toBe('')
    await context.fiber.dispose()
  })
})
