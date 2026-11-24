import { AntigravityError, blocks, type AgMessage, type AgResult } from './antigravityProtocol'
import { agTextTokenWeight, estimateAgTextTokens } from './antigravityTokens'

export type AgStepLimit = { readonly bytes: number; readonly tokens: number }
export type AgStepChange = { readonly count: number; readonly before: number; readonly after: number }
export type AgStepObserver = (change: AgStepChange) => void

export class AgStepBudgetError extends AntigravityError {
  readonly bytes: number
  constructor(bytes: number, reason: string) {
    super(reason + '. Shorten the message or put the content into a file and reference the file. For tool output, request a smaller result.')
    this.bytes = bytes
  }
}

export function fitsAgStep(prompt: string, limit: AgStepLimit): boolean {
  return Buffer.byteLength(prompt) <= limit.bytes && estimateAgTextTokens(prompt) <= limit.tokens
}

export function assertAgStep(prompt: string, limit: AgStepLimit): string {
  const bytes = Buffer.byteLength(prompt)
  if (bytes > limit.bytes) throw new AgStepBudgetError(bytes, 'Antigravity input step is ' + bytes + ' bytes; the limit is ' + limit.bytes + ' bytes')
  if (estimateAgTextTokens(prompt) > limit.tokens) throw new AgStepBudgetError(bytes, 'Antigravity input step exceeds its estimated budget of ' + limit.tokens + ' tokens')
  return prompt
}

type Candidate = {
  readonly text: string
  readonly bytes: number
  readonly wire: string
  readonly label: string
  readonly tool: boolean
  readonly replace: (head: number, tail: number, marker: string) => string
}

function cut(text: string, at: number, direction: -1 | 1): number {
  return (text.charCodeAt(at - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(at) & 0xfc00) === 0xdc00 ? at + direction : at
}

function cutResult(result: AgResult, head: number, tail: number, marker: string): AgResult {
  if (typeof result.content === 'string') return { ...result, content: result.content.slice(0, head) + marker + result.content.slice(tail) }
  let offset = 0, inserted = false
  const content = result.content?.map(part => {
    if (part.type !== 'text') return part
    const start = offset
    offset += part.text.length
    if (offset <= head || start >= tail) return part
    const prefix = part.text.slice(0, Math.max(0, head - start))
    const suffix = part.text.slice(Math.max(0, tail - start))
    const text = prefix + (inserted ? '' : marker) + suffix
    inserted = true
    return { ...part, text }
  })
  return { ...result, content }
}

interface FitStep {
  readonly messages: AgMessage[]
  readonly render: (messages: AgMessage[]) => string
  readonly protect: number
  readonly limit: AgStepLimit
  readonly observe?: AgStepObserver
  readonly toolNames?: ReadonlyMap<string, string>
}

/** Keep the client history and call identity intact; only reduce the wire copy. */
export function fitAgStep({ messages, render, protect, limit, observe, toolNames }: FitStep) {
  const original = render(messages)
  if (fitsAgStep(original, limit)) return { messages, prompt: original }
  const names = new Map(toolNames)
  for (const message of messages) for (const block of blocks(message)) {
    if (block.type === 'tool_use') names.set(block.id, block.name)
  }
  const candidates: Candidate[] = []
  const draft = messages.slice()
  const add = ({ text, ...candidate }: Omit<Candidate, 'bytes'>) => {
    const bytes = Buffer.byteLength(text)
    if (bytes > 2) candidates.push({ ...candidate, text, bytes })
  }
  for (const [i, message] of messages.entries()) {
    if (typeof message.content === 'string') {
      const text = message.content
      if (i !== protect) add({ text, wire: JSON.stringify(text), label: 'Historical message', tool: false, replace: (head, tail, marker) => {
        const content = text.slice(0, head) + marker + text.slice(tail)
        draft[i] = { ...message, content }
        return JSON.stringify(content)
      } })
      continue
    }
    const content = message.content.slice()
    const replace = (j: number, block: typeof content[number]) => {
      content[j] = block
      draft[i] = { ...message, content }
      return JSON.stringify(block)
    }
    for (const [j, block] of message.content.entries()) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : block.content?.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? ''
        const name = names.get(block.tool_use_id)
        const label = 'Tool result' + (name ? ' ' + JSON.stringify(name) : '') + ' (call ' + JSON.stringify(block.tool_use_id) + ')'
        add({ text, wire: JSON.stringify(block), label, tool: true, replace: (head, tail, marker) => replace(j, cutResult(block, head, tail, marker)) })
      } else if (block.type === 'text' && i !== protect) {
        add({ text: block.text, wire: JSON.stringify(block), label: 'Historical message', tool: false,
          replace: (head, tail, marker) => replace(j, { ...block, text: block.text.slice(0, head) + marker + block.text.slice(tail) }) })
      }
    }
  }

  // Every candidate replaces a JSON value in the frame. Measure only its changed bytes.
  const originalBytes = Buffer.byteLength(original)
  let remainingBytes = originalBytes, remainingTokens = agTextTokenWeight(original), count = 0
  for (const { text, bytes, wire, label, tool, replace } of candidates.sort((a, b) => b.bytes - a.bytes)) {
    const otherBytes = remainingBytes - Buffer.byteLength(wire), otherTokens = remainingTokens - agTextTokenWeight(wire)
    const reduce = (keep: number) => {
      const head = cut(text, Math.ceil(keep / 2), 1), tail = cut(text, text.length - Math.floor(keep / 2), -1)
      const omitted = tail > head ? Buffer.byteLength(text.slice(head, tail)) : 0
      const instruction = tool ? ' Call the tool again with a narrower request for omitted content.' : ''
      const marker = '\n[Meridian: ' + label + ', ' + bytes + ' original bytes, ' + omitted + ' bytes omitted.' + instruction + ']\n'
      if (omitted <= Buffer.byteLength(marker)) return undefined
      const encoded = replace(head, tail, marker)
      return { bytes: otherBytes + Buffer.byteLength(encoded), tokens: otherTokens + agTextTokenWeight(encoded) }
    }
    const smallest = reduce(2)
    if (smallest === undefined) continue
    count++
    remainingBytes = smallest.bytes
    remainingTokens = smallest.tokens
    if (remainingBytes > limit.bytes || remainingTokens > limit.tokens) continue
    let low = 2, high = text.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const prompt = reduce(mid)
      if (prompt !== undefined && prompt.bytes <= limit.bytes && prompt.tokens <= limit.tokens) low = mid
      else high = mid - 1
    }
    reduce(low)
    const prompt = assertAgStep(render(draft), limit)
    observe?.({ count, before: originalBytes, after: Buffer.byteLength(prompt) })
    return { messages: draft, prompt }
  }
  return undefined
}
