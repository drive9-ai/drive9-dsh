import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { EvidenceManifestV1 } from './evidence.js'
import { extractReceipts } from './receipt.js'
import type { EvidenceReceiptV1 } from './receipt.js'

interface IssuingEvent {
  readonly callId: string
  readonly toolName: string
  readonly label: 'result' | 'dispatch'
  readonly content: readonly ContentBlock[]
}

function textBlocks(content: readonly ContentBlock[]): string[] {
  return content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

function issuingEvent(event: SessionEvent, toolNameForCall: string | undefined): IssuingEvent | undefined {
  if (event.type === 'tool/result') {
    const block = event.data.message.content[0]
    if (block.type !== 'tool-result') return undefined
    const callId = String(block.toolCallId)
    if (toolNameForCall === undefined) return undefined
    return { callId, toolName: toolNameForCall, label: 'result', content: block.content }
  }
  if (event.type === 'tool/code-dispatch') {
    return {
      callId: String(event.data.subCallId),
      toolName: event.data.name,
      label: 'dispatch',
      content: event.data.content,
    }
  }
  return undefined
}

function receiptMatches(
  receipt: EvidenceReceiptV1,
  issued: IssuingEvent,
  manifest: EvidenceManifestV1,
  manifestSha256: string,
  locator: string,
): boolean {
  return receipt.locator === locator
    && receipt.sessionId === manifest.sessionId
    && receipt.toolName === manifest.toolName
    && String(receipt.callId) === String(manifest.callId)
    && receipt.manifestSha256 === manifestSha256
    && receipt.toolName === issued.toolName
    && String(receipt.callId) === issued.callId
    && manifest.label === issued.label
}

export function isEvidenceAuthorized(
  session: Session,
  locator: string,
  manifest: EvidenceManifestV1,
  manifestSha256: string,
): boolean {
  const seedLength = session.header.seedLength ?? 0
  const seededCalls = new Map<string, string>()
  const liveCalls = new Map<string, string>()
  for (const event of session.events) {
    const seeded = event.seq < seedLength
    const calls = seeded ? seededCalls : liveCalls
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), event.data.name)
      continue
    }
    const toolName = event.type === 'tool/result'
      && event.data.message.content[0].type === 'tool-result'
      ? calls.get(String(event.data.message.content[0].toolCallId))
      : undefined
    const issued = issuingEvent(event, toolName)
    if (issued === undefined) continue
    const receipts = textBlocks(issued.content).flatMap(extractReceipts)
    if (!receipts.some(receipt => receiptMatches(receipt, issued, manifest, manifestSha256, locator))) continue
    if (seeded) {
      return session.header.parentSession !== undefined
        && manifest.sessionId === session.header.parentSession
    }
    return manifest.sessionId === session.header.id
  }
  return false
}
