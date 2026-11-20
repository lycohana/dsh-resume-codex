/**
 * Convert normalized Codex records into the seed event log of one DSH session.
 *
 * The shape mirrors the official DeepSeek chat import: one empty `system/message`
 * opens the surface (node 0), every user message opens a turn, and each
 * assistant message is one step of that turn. The empty system node exists so a
 * resumed agent can replace it with the real system prompt instead of appending
 * a system message after imported history.
 *
 * @module dsh-resume-codex/convert
 */

import { randomUUID } from 'node:crypto'

/** Marker around the decoded Codex compaction summary. */
export const SUMMARY_PREFIX = '〔Codex 会话摘要 · 压缩前的上下文〕'
/** Marker closing the decoded Codex compaction summary. */
export const SUMMARY_SUFFIX = '〔摘要结束，以下接续压缩后的对话〕'

/** Mint one message id. */
function messageId() {
  return `msg_${randomUUID()}`
}

/** Mint one tool-call id. */
function callId() {
  return `call_${randomUUID()}`
}

/** Bound one tool output without splitting a surrogate pair. */
function clip(text, limit) {
  if (text.length <= limit) return text
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${text.slice(0, end)}\n…（输出已截断）`
}

/**
 * Build the seed events.
 * @param {object} input - normalized transcript and display facts.
 * @param {object[]} input.items - records from {@link readItems}.
 * @param {string | undefined} input.summary - decoded compaction summary.
 * @param {string} input.title - session title.
 * @param {number} input.createdAt - creation instant.
 * @param {string | undefined} input.model - Codex model recorded on assistant messages.
 * @param {boolean} input.includeTools - whether tool calls join the history.
 * @param {number} input.toolResultMaxChars - per-output cap.
 * @returns {{events: object[], stats: object}} seed events and their statistics.
 * @throws {Error} when the transcript holds no user message.
 */
export function convertTranscript(input) {
  const { items, summary, title, createdAt, model, includeTools, toolResultMaxChars } = input
  const events = []
  let time = createdAt
  let turn = 0
  let titleWritten = false
  let headWritten = false
  let realTurns = 0
  let toolCalls = 0

  const push = (type, data, extra) => {
    const event = { type, seq: events.length, time, data, ...(extra ?? {}) }
    events.push(event)
    return event.seq
  }
  const advance = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > time) time = value
  }
  const source = { kind: 'model', provider: 'codex', model: model ?? 'codex' }

  const writeTitle = () => {
    if (titleWritten || title === '' || title === undefined) return
    titleWritten = true
    push('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
  }

  // The decoded Codex summary leads the imported history as a user message:
  // a system message mid-history could be read as the effective system prompt,
  // and DSH drops developer messages while assembling requests.
  if (typeof summary === 'string' && summary.trim() !== '') {
    turn += 1
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('system/message', {
      turn,
      step: 1,
      message: { id: messageId(), role: 'system', content: [], source: { kind: 'system-prompt' } },
    }, { surfaceOp: 'append' })
    headWritten = true
    push('user/message', {
      turn,
      step: 1,
      id: messageId(),
      role: 'user',
      content: [{ type: 'text', text: `${SUMMARY_PREFIX}\n${summary}\n${SUMMARY_SUFFIX}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
    writeTitle()
  }

  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item.kind !== 'user') {
      index += 1
      continue
    }
    turn += 1
    realTurns += 1
    advance(item.time)
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    if (!headWritten) {
      push('system/message', {
        turn,
        step: 1,
        message: { id: messageId(), role: 'system', content: [], source: { kind: 'system-prompt' } },
      }, { surfaceOp: 'append' })
      headWritten = true
    }
    push('user/message', {
      turn,
      step: 1,
      id: messageId(),
      role: 'user',
      content: [{ type: 'text', text: item.text }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    // Group the rest of this turn into assistant segments with their tool calls.
    const segments = []
    let current
    let cursor = index + 1
    for (; cursor < items.length; cursor += 1) {
      const next = items[cursor]
      if (next.kind === 'user') break
      if (next.kind === 'assistant') {
        current = { assistant: next, calls: [] }
        segments.push(current)
        continue
      }
      if (next.kind === 'tool-call') {
        if (current !== undefined) {
          current.calls.push({
            callId: next.callId,
            name: next.name,
            arguments: next.arguments,
            time: next.time,
            result: undefined,
          })
        }
        continue
      }
      if (next.kind === 'tool-output') {
        const call = current?.calls.find(entry => entry.callId === next.callId && entry.result === undefined)
        if (call !== undefined) call.result = next
      }
    }

    const usable = []
    for (const segment of segments) {
      const text = segment.assistant.text.trim()
      const paired = includeTools ? segment.calls.filter(call => call.result !== undefined) : []
      if (text === '' && paired.length === 0) continue
      usable.push({ segment, text, paired })
    }

    if (usable.length === 0) {
      push('step/end', { turn, step: 1 })
      push('turn/end', { turn, reason: { kind: 'completed' } })
      writeTitle()
      index = cursor
      continue
    }

    usable.forEach((entry, position) => {
      const step = position + 1
      if (step > 1) push('step/start', { turn, step })
      // Allocate the call ids once so the message blocks and the tool/call
      // events carry the same identity.
      const calls = entry.paired.map(call => ({ ...call, id: callId() }))
      const blocks = []
      if (entry.text !== '') blocks.push({ type: 'text', text: entry.text })
      for (const call of calls) {
        blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
      }
      if (blocks.length > 0) {
        advance(entry.segment.assistant.time)
        push('assistant/message', {
          turn,
          step,
          message: { id: messageId(), role: 'assistant', content: blocks, source: { ...source } },
          stream: [],
        }, { surfaceOp: 'append' })
      }
      for (const call of calls) {
        toolCalls += 1
        const callSeq = push('tool/call', {
          turn,
          step,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        })
        advance(call.result.time)
        push('tool/result', {
          turn,
          step,
          message: {
            id: messageId(),
            role: 'tool',
            content: [{ type: 'text', text: clip(call.result.text, toolResultMaxChars) }],
            source: { kind: 'tool', callId: call.id },
            toolCallId: call.id,
            ...(call.result.isError ? { isError: true } : {}),
          },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
      }
      push('step/end', { turn, step })
    })

    push('turn/end', { turn, reason: { kind: 'completed' } })
    writeTitle()
    index = cursor
  }

  if (realTurns === 0 && (summary === undefined || summary.trim() === '')) {
    throw new Error('codex transcript has no user message')
  }
  writeTitle()
  return {
    events,
    stats: { turns: realTurns, events: events.length, toolCalls },
  }
}
