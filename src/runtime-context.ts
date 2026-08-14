import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Drive9MountConsistency } from './filesystem.js'

export const name = 'drive9-runtime-context'
export const inject = ['systemPrompt']

export interface Drive9RuntimeContextConfig {
  mountConsistency?: Drive9MountConsistency
}

export const Config: z<Drive9RuntimeContextConfig> = z.object({
  mountConsistency: z.union([z.const('strong'), z.const('eventual')]).default('strong'),
})

export function apply(ctx: Context, config: Drive9RuntimeContextConfig = {}): void {
  if ((config.mountConsistency ?? 'strong') !== 'eventual') return
  ctx.systemPrompt.context({
    name: 'drive9:mount-consistency',
    order: 115,
    text: 'Drive9 workspace storage operations use the SDK, but this deployment uses eventual mount consistency. Bash, rg, tests, language servers, and other subprocesses may read stale mounted bytes after a successful workspace write. Do not treat an immediate subprocess read as authoritative.',
  })
}
