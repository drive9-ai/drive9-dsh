import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
const RESULT_ID = /drive9-result:v1:[A-Za-z0-9_-]{43}/u

type ScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[])

export function toolCall(callId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(callId)
  const serialized = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function resultIdFrom(options: GenerateOptions): string {
  const match = JSON.stringify(options.messages).match(RESULT_ID)
  if (match?.[0] === undefined) throw new Error('script expected a Drive9 result_id in model history')
  return match[0]
}

export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

export function toolResultText(agent: Agent, callId: string): string {
  const event = agent.session.events.find(candidate => candidate.type === 'tool/result'
    && candidate.data.message.content[0].type === 'tool-result'
    && String(candidate.data.message.content[0].toolCallId) === callId)
  if (event?.type !== 'tool/result') return ''
  const block = event.data.message.content[0]
  if (block.type !== 'tool-result') return ''
  return block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('')
}
