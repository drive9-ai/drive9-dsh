import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Drive9EvidenceStore } from './evidence.js'
import { isEvidenceAuthorized } from './authorization.js'
import { Drive9ResultError } from './result-error.js'
import { truncateUtf8 } from './text.js'

export const name = 'drive9-result-tools'
export const inject = ['tools', 'spillStore']

export const HARD_MAX_RETURN_LINES = 1000
export const HARD_MAX_RETURN_BYTES = 64 * 1024
export const HARD_MAX_SEARCH_MATCHES = 100
export const HARD_MAX_SCAN_BYTES = 64 * 1024 * 1024
export const HARD_MAX_QUERY_BYTES = 64 * 1024

export interface Drive9ResultToolsConfig {
  maxReturnLines?: number
  maxReturnBytes?: number
  maxSearchMatches?: number
  maxScanBytes?: number
}

interface ResolvedConfig {
  readonly maxReturnLines: number
  readonly maxReturnBytes: number
  readonly maxSearchMatches: number
  readonly maxScanBytes: number
}

export const Config: z<Drive9ResultToolsConfig> = z.object({
  maxReturnLines: z.number().default(HARD_MAX_RETURN_LINES),
  maxReturnBytes: z.number().default(HARD_MAX_RETURN_BYTES),
  maxSearchMatches: z.number().default(HARD_MAX_SEARCH_MATCHES),
  maxScanBytes: z.number().default(HARD_MAX_SCAN_BYTES),
})

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function boundedPositive(value: number | undefined, fallback: number, hardMax: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMax) {
    throw new TypeError(`drive9-dsh: ${name} must be an integer between 1 and ${hardMax}`)
  }
  return resolved
}

function resolveConfig(config: Drive9ResultToolsConfig): ResolvedConfig {
  return {
    maxReturnLines: boundedPositive(config.maxReturnLines, HARD_MAX_RETURN_LINES, HARD_MAX_RETURN_LINES, 'maxReturnLines'),
    maxReturnBytes: boundedPositive(config.maxReturnBytes, HARD_MAX_RETURN_BYTES, HARD_MAX_RETURN_BYTES, 'maxReturnBytes'),
    maxSearchMatches: boundedPositive(config.maxSearchMatches, HARD_MAX_SEARCH_MATCHES, HARD_MAX_SEARCH_MATCHES, 'maxSearchMatches'),
    maxScanBytes: boundedPositive(config.maxScanBytes, HARD_MAX_SCAN_BYTES, HARD_MAX_SCAN_BYTES, 'maxScanBytes'),
  }
}

function evidenceStore(ctx: Context): Drive9EvidenceStore {
  const store = ctx.spillStore
  if (!(store instanceof Drive9EvidenceStore)) {
    throw new Drive9ResultError('Drive9 evidence backend is not loaded', 'DRIVE9_RESULT_IO')
  }
  return store
}

function sessionOf(exec: ToolRunContext) {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Drive9ResultError('Drive9 result tools require a live agent session', 'DRIVE9_RESULT_UNAUTHORIZED')
  }
  return session
}

async function authorizedEvidence(ctx: Context, exec: ToolRunContext, locator: string, maxScanBytes: number) {
  const session = sessionOf(exec)
  const published = await evidenceStore(ctx).readPublished(locator, maxScanBytes, exec.signal)
  if (!isEvidenceAuthorized(session, locator, published.manifest, published.manifestSha256)) {
    throw new Drive9ResultError('Drive9 result_id was not issued to this session', 'DRIVE9_RESULT_UNAUTHORIZED')
  }
  return published
}

function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function renderRead(content: string, offset: number, limit: number, maxBytes: number): string {
  const lines = splitLines(content)
  const selected = lines.slice(offset, offset + limit)
  if (selected.length === 0) return `No result lines at offset ${offset}. Total lines: ${lines.length}.`
  const body = selected.map((line, index) => `L${offset + index + 1}: ${line}`).join('\n')
  const header = `Result lines ${offset + 1}-${offset + selected.length} of ${lines.length}:\n`
  return truncateUtf8(`${header}${body}`, maxBytes)
}

function renderSearch(
  content: string,
  query: string,
  maxMatches: number,
  contextLines: number,
  maxBytes: number,
): string {
  const lines = splitLines(content)
  const needle = query.toLowerCase()
  const matched: number[] = []
  for (let index = 0; index < lines.length && matched.length < maxMatches; index += 1) {
    if (lines[index]?.toLowerCase().includes(needle)) matched.push(index)
  }
  if (matched.length === 0) return `No matches for ${JSON.stringify(query)}.`

  const rendered: string[] = [`Matches for ${JSON.stringify(query)}:`]
  let previousEnd = -1
  for (const index of matched) {
    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length - 1, index + contextLines)
    if (start > previousEnd + 1) rendered.push('--')
    for (let line = Math.max(start, previousEnd + 1); line <= end; line += 1) {
      rendered.push(`${line === index ? '>' : ' '} L${line + 1}: ${lines[line] ?? ''}`)
    }
    previousEnd = Math.max(previousEnd, end)
  }
  return truncateUtf8(rendered.join('\n'), maxBytes)
}

export function apply(ctx: Context, config: Drive9ResultToolsConfig = {}): void {
  const resolved = resolveConfig(config)
  ctx.tools.register(defineTool({
    name: 'result_read',
    description: 'Read a bounded line range from an exact Drive9 evidence result_id issued to this session.',
    parameters: {
      result_id: { type: 'string', required: true, description: 'Exact Drive9 result_id from a prior tool result.' },
      offset: { type: 'integer', description: 'Zero-based line offset. Defaults to 0.' },
      limit: { type: 'integer', description: `Maximum lines to return. Defaults to ${resolved.maxReturnLines}.` },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const offset = args.offset ?? 0
      const limit = args.limit ?? resolved.maxReturnLines
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Drive9ResultError('result_read offset must be a non-negative integer', 'DRIVE9_RESULT_INVALID_ID')
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > resolved.maxReturnLines) {
        throw new Drive9ResultError(`result_read limit must be between 1 and ${resolved.maxReturnLines}`, 'DRIVE9_RESULT_SCAN_LIMIT')
      }
      const result = await authorizedEvidence(ctx, exec, args.result_id, resolved.maxScanBytes)
      return renderRead(result.content, offset, limit, resolved.maxReturnBytes)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'result_search',
    description: 'Search one exact Drive9 evidence result_id using a bounded literal, case-insensitive query.',
    parameters: {
      result_id: { type: 'string', required: true, description: 'Exact Drive9 result_id from a prior tool result.' },
      query: { type: 'string', required: true, description: 'Literal UTF-8 query text.' },
      max_matches: { type: 'integer', description: `Maximum matches to return. Defaults to ${resolved.maxSearchMatches}.` },
      context_lines: { type: 'integer', description: 'Context lines before and after each match. Defaults to 0; maximum 20.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.query.length === 0 || Buffer.byteLength(args.query, 'utf8') > HARD_MAX_QUERY_BYTES) {
        throw new Drive9ResultError(`result_search query must be 1-${HARD_MAX_QUERY_BYTES} UTF-8 bytes`, 'DRIVE9_RESULT_SCAN_LIMIT')
      }
      const maxMatches = args.max_matches ?? resolved.maxSearchMatches
      const contextLines = args.context_lines ?? 0
      if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > resolved.maxSearchMatches) {
        throw new Drive9ResultError(
          `result_search max_matches must be between 1 and ${resolved.maxSearchMatches}`,
          'DRIVE9_RESULT_SCAN_LIMIT',
        )
      }
      if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 20) {
        throw new Drive9ResultError('result_search context_lines must be between 0 and 20', 'DRIVE9_RESULT_SCAN_LIMIT')
      }
      const result = await authorizedEvidence(ctx, exec, args.result_id, resolved.maxScanBytes)
      return renderSearch(result.content, args.query, maxMatches, contextLines, resolved.maxReturnBytes)
    },
  }))
}

const plugin = Object.assign(apply, { inject, Config })

export default plugin
