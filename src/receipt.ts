import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export const RESULT_LOCATOR_PREFIX = 'drive9-result:v1:'
export const RECEIPT_PREFIX = 'drive9-evidence-receipt:v1:'
export const RECEIPT_MARKER = 'DRIVE9_EVIDENCE_RECEIPT '

export interface EvidenceReceiptV1 {
  readonly v: 1
  readonly locator: string
  readonly sessionId: SessionId
  readonly toolName: string
  readonly callId: CallId
  readonly manifestSha256: string
}

export function encodeLocator(capability: string): string {
  return `${RESULT_LOCATOR_PREFIX}${capability}`
}

export function parseLocator(locator: string): string | undefined {
  const match = /^drive9-result:v1:([A-Za-z0-9_-]{43})$/u.exec(locator)
  return match?.[1]
}

export function encodeReceipt(receipt: EvidenceReceiptV1): string {
  const serialized = JSON.stringify({
    v: receipt.v,
    locator: receipt.locator,
    sessionId: receipt.sessionId,
    toolName: receipt.toolName,
    callId: receipt.callId,
    manifestSha256: receipt.manifestSha256,
  })
  return `${RECEIPT_PREFIX}${Buffer.from(serialized, 'utf8').toString('base64url')}`
}

export function parseReceipt(encoded: string): EvidenceReceiptV1 | undefined {
  if (!encoded.startsWith(RECEIPT_PREFIX)) return undefined
  const payload = encoded.slice(RECEIPT_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return undefined
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (keys.join(',') !== 'callId,locator,manifestSha256,sessionId,toolName,v') return undefined
    if (record.v !== 1
      || typeof record.locator !== 'string'
      || parseLocator(record.locator) === undefined
      || typeof record.sessionId !== 'string'
      || typeof record.toolName !== 'string'
      || typeof record.callId !== 'string'
      || typeof record.manifestSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(record.manifestSha256)) return undefined
    const receipt = record as unknown as EvidenceReceiptV1
    return encodeReceipt(receipt) === encoded ? receipt : undefined
  } catch {
    return undefined
  }
}

export function extractReceipts(text: string): EvidenceReceiptV1[] {
  const receipts: EvidenceReceiptV1[] = []
  const pattern = /DRIVE9_EVIDENCE_RECEIPT (drive9-evidence-receipt:v1:[A-Za-z0-9_-]+)/gu
  for (const match of text.matchAll(pattern)) {
    const encoded = match[1]
    if (encoded === undefined) continue
    const receipt = parseReceipt(encoded)
    if (receipt !== undefined) receipts.push(receipt)
  }
  return receipts
}
