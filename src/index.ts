import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Drive9FileSystem from './filesystem.js'
import type { Drive9FileSystemConfig } from './filesystem.js'
import Drive9EvidenceStore from './evidence.js'
import type { Drive9EvidenceConfig } from './evidence.js'
import * as resultTools from './result-tools.js'
import type { Drive9ResultToolsConfig } from './result-tools.js'
import * as runtimeContext from './runtime-context.js'

export { Drive9FileSystem } from './filesystem.js'
export type { Drive9FileSystemConfig, Drive9MountConsistency } from './filesystem.js'
export { Drive9EvidenceStore } from './evidence.js'
export type { Drive9EvidenceConfig, EvidenceManifestV1, PublishedEvidence } from './evidence.js'
export { Drive9ResultError } from './result-error.js'
export type { Drive9ResultErrorCode } from './result-error.js'
export {
  DRIVE9_WORKSPACE_COMMITTED_MOUNT_UNCONFIRMED,
  Drive9WorkspaceCommittedMountUnconfirmedError,
} from './mount-error.js'
export type { Drive9MountUnconfirmedReason } from './mount-error.js'
export {
  HARD_MAX_QUERY_BYTES,
  HARD_MAX_RETURN_BYTES,
  HARD_MAX_RETURN_LINES,
  HARD_MAX_SCAN_BYTES,
  HARD_MAX_SEARCH_MATCHES,
} from './result-tools.js'
export type { Drive9ResultToolsConfig } from './result-tools.js'

export const name = 'drive9-dsh'

export interface Drive9DshConfig {
  readonly filesystem: Drive9FileSystemConfig
  readonly evidence: Drive9EvidenceConfig
  readonly resultTools?: Drive9ResultToolsConfig
}

export const Config: z<Drive9DshConfig> = z.object({
  filesystem: Drive9FileSystem.Config.required(),
  evidence: Drive9EvidenceStore.Config.required(),
  resultTools: resultTools.Config.default({}),
})

export async function apply(ctx: Context, config: Drive9DshConfig): Promise<void> {
  if (config.filesystem.apiKey === undefined || config.filesystem.apiKey.length === 0) {
    throw new TypeError('drive9-dsh: filesystem apiKey is required for SDK-backed revision CAS')
  }
  if (config.evidence.apiKey === undefined || config.evidence.apiKey.length === 0) {
    throw new TypeError('drive9-dsh: evidence apiKey is required')
  }
  if (config.filesystem.apiKey === config.evidence.apiKey) {
    throw new TypeError('drive9-dsh: workspace and evidence must use different scoped credentials')
  }
  await ctx.plugin(Drive9FileSystem, config.filesystem)
  await ctx.plugin(Drive9EvidenceStore, {
    ...config.evidence,
    workspaceApiKey: config.filesystem.apiKey,
  })
  await ctx.plugin(resultTools, config.resultTools ?? {})
  await ctx.plugin(runtimeContext, { mountConsistency: config.filesystem.mountConsistency ?? 'strong' })
}
