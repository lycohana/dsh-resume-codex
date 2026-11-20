/**
 * Read-only access to the Codex rollout log format.
 *
 * A rollout is JSONL under `<codex home>/sessions/YYYY/MM/DD` (archived files
 * sit under `<codex home>/archived_sessions`). One line per record; the first
 * record is `session_meta` with the working directory, and conversation items
 * are `response_item` records. Nothing here writes to the Codex home.
 *
 * @module dsh-resume-codex/codex
 */

import { createReadStream } from 'node:fs'
import { readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** Default Codex home when neither config nor `CODEX_HOME` names one. */
export function defaultCodexHome() {
  const fromEnv = process.env.CODEX_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.codex')
}

/** Parse one ISO timestamp to epoch milliseconds, or undefined. */
export function parseTime(value) {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Resolve and canonicalize the Codex home.
 * @param {string | undefined} configured - configured home, if any.
 * @returns {Promise<string | undefined>} canonical directory, or undefined when absent.
 */
export async function resolveCodexHome(configured) {
  const candidate = configured !== undefined && configured.trim() !== '' ? resolve(configured) : defaultCodexHome()
  try {
    const info = await stat(candidate)
    if (!info.isDirectory()) return undefined
    return await realpath(candidate)
  } catch {
    return undefined
  }
}

/**
 * List every readable rollout file below one directory tree.
 * @param {string} directory - directory to walk.
 * @param {number} depth - remaining directory depth.
 * @param {string[]} out - collector.
 * @returns {Promise<void>}
 */
async function walkRollouts(directory, depth, out) {
  if (depth < 0) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await walkRollouts(path, depth - 1, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(path)
    }
  }
}

/**
 * Collect the rollout files of one Codex home.
 * @param {string} home - canonical Codex home.
 * @returns {Promise<string[]>} absolute rollout paths.
 */
export async function listRolloutFiles(home) {
  const out = []
  await walkRollouts(join(home, 'sessions'), 4, out)
  await walkRollouts(join(home, 'archived_sessions'), 2, out)
  return out
}

/**
 * Read one file line by line.
 * @param {string} path - file to read.
 * @param {number} fromLine - 1-based first line to hand to the callback.
 * @param {(line: string, lineNumber: number) => boolean | void | Promise<boolean | void>} onLine - consumer; false stops.
 * @returns {Promise<void>}
 */
async function eachLine(path, fromLine, onLine) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  try {
    for await (const line of reader) {
      lineNumber += 1
      if (lineNumber < fromLine) continue
      if (line.trim() === '') continue
      const stop = await onLine(line, lineNumber)
      if (stop === false) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }
}

/** Join the text parts of one Codex content array. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.text === 'string' && item.text !== '') {
      parts.push(item.text)
    } else if (item.type === 'input_image' || item.type === 'image') {
      parts.push('[图片]')
    } else if (item.type === 'input_file' || item.type === 'file') {
      parts.push('[文件]')
    }
  }
  return parts.join('\n')
}

/** User-role records Codex writes for itself rather than for the user. */
const SYNTHETIC_USER_PREFIXES = [
  'Side conversation boundary.',
  '<environment_context>',
  '<user_instructions>',
  '<turn_aborted>',
]

/**
 * Whether one user-role text belongs in the imported conversation. Codex
 * injects fork boundaries, environment blocks and instruction blocks as
 * user-role records; those are harness context, not user speech.
 * @param {string} text - joined message text.
 * @returns {boolean} true for importable user content.
 */
export function isConversationUserText(text) {
  const trimmed = text.trimStart()
  if (trimmed === '') return false
  for (const prefix of SYNTHETIC_USER_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false
  }
  return true
}

/**
 * Whether one user-role text is human speech worth titling a session with.
 * Attachment-only records are real content but make poor titles.
 * @param {string} text - joined message text.
 * @returns {boolean} true for a usable title source.
 */
export function isHumanUserText(text) {
  if (!isConversationUserText(text)) return false
  return !/^#\s*Files mentioned by the user:/u.test(text.trimStart())
}

/** Collapse whitespace and bound a title to roughly one line. */
export function cleanTitle(text, max = 96) {
  const collapsed = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1)}…`
}

/**
 * Read the identifying head of one rollout without loading the whole file.
 * @param {string} path - rollout file.
 * @returns {Promise<object>} identity and display facts.
 */
export async function readHead(path) {
  let meta
  let model
  let title
  let forkedFrom
  let firstTime
  let lines = 0
  await eachLine(path, 1, (line) => {
    lines += 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return lines >= 1200
    }
    if (lines === 1) firstTime = parseTime(record.timestamp)
    if (record.type === 'session_meta') {
      meta = record.payload ?? {}
      forkedFrom = meta.forked_from_id ?? meta.forkedFrom ?? undefined
    } else if (record.type === 'turn_context' && model === undefined) {
      if (typeof record.payload?.model === 'string') model = record.payload.model
    } else if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
      const text = contentText(record.payload.content)
      if (title === undefined && isHumanUserText(text)) title = text
    }
    // The first human user message is the display title; the model may arrive
    // on a later turn_context, so keep reading until both are known.
    return (title !== undefined && model !== undefined) || lines >= 1200 ? false : undefined
  })
  const info = await stat(path)
  const fileName = basename(path)
  const id = meta?.id ?? meta?.session_id ?? fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u)?.[0] ?? fileName
  return {
    path,
    id: String(id),
    title: title === undefined ? '' : cleanTitle(title),
    cwd: typeof meta?.cwd === 'string' ? meta.cwd : undefined,
    createdAt: parseTime(meta?.timestamp) ?? firstTime ?? info.birthtimeMs ?? info.mtimeMs,
    updatedAt: info.mtimeMs,
    size: info.size,
    model: typeof model === 'string' ? model : undefined,
    forkedFrom: typeof forkedFrom === 'string' ? forkedFrom : undefined,
    archived: path.includes(`${sep}archived_sessions${sep}`),
  }
}

/**
 * Decode the base64 body of one Codex compaction item.
 * @param {unknown} raw - `encrypted_content` of a `compaction` item.
 * @returns {string | undefined} readable summary, or undefined when unrecognized.
 */
export function decodeCompaction(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const body = raw.startsWith('ccswitch-compaction-v1:') ? raw.slice('ccswitch-compaction-v1:'.length) : raw
  try {
    const text = Buffer.from(body, 'base64').toString('utf8')
    return text.trim() === '' ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * First pass: find the last compaction and every user-message boundary.
 * @param {string} path - rollout file.
 * @returns {Promise<object>} scan facts used to choose the imported window.
 */
export async function scanRollout(path) {
  let meta
  let model
  let compaction
  let totalBytes = 0
  let totalLines = 0
  const userLines = []
  const userOffsets = []
  await eachLine(path, 1, (line, lineNumber) => {
    totalLines = lineNumber
    const offset = totalBytes
    totalBytes += Buffer.byteLength(line, 'utf8') + 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (record.type === 'session_meta' && meta === undefined) {
      meta = record.payload ?? {}
      return
    }
    if (record.type === 'turn_context' && model === undefined) {
      if (typeof record.payload?.model === 'string') model = record.payload.model
      return
    }
    if (record.type === 'compacted') {
      const history = Array.isArray(record.payload?.replacement_history) ? record.payload.replacement_history : []
      const item = history.find(entry => entry?.type === 'compaction')
      const summary = decodeCompaction(item?.encrypted_content)
      if (summary !== undefined) compaction = { line: lineNumber, summary, time: parseTime(record.timestamp) }
      return
    }
    if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
      const text = contentText(record.payload.content)
      if (isConversationUserText(text)) {
        userLines.push(lineNumber)
        userOffsets.push(offset)
      }
    }
  })
  return { meta, model, compaction, totalBytes, totalLines, userLines, userOffsets }
}

/**
 * Choose the first line of the imported window.
 * @param {object} scan - {@link scanRollout} result.
 * @param {{mode: 'smart'|'full', maxTurns: number, maxChars: number}} options - window policy.
 * @returns {{startLine: number, truncated: boolean, droppedTurns: number}} window start.
 */
export function chooseWindow(scan, options) {
  const budget = options.maxChars
  const compactionLine = options.mode === 'smart' ? (scan.compaction?.line ?? 0) : 0
  const boundaries = []
  for (let index = 0; index < scan.userLines.length; index += 1) {
    const line = scan.userLines[index]
    if (line <= compactionLine) continue
    boundaries.push(index)
  }
  if (options.mode === 'full') {
    // Everything from the beginning; only the byte budget may cut the head.
    if (scan.totalBytes <= budget || scan.userLines.length === 0) {
      return { startLine: 0, truncated: false, droppedTurns: 0 }
    }
    let keep = 0
    for (let index = scan.userLines.length - 1; index >= 0; index -= 1) {
      const cost = scan.totalBytes - scan.userOffsets[index]
      if (cost > budget) break
      keep = index
    }
    return {
      startLine: scan.userLines[keep],
      truncated: keep > 0,
      droppedTurns: keep,
    }
  }
  let keep = boundaries
  if (options.maxTurns > 0 && keep.length > options.maxTurns) {
    keep = keep.slice(keep.length - options.maxTurns)
  }
  if (keep.length === 0) {
    const fallback = compactionLine > 0 ? compactionLine + 1 : 1
    return { startLine: fallback, truncated: false, droppedTurns: 0 }
  }
  // Byte budget: drop oldest turns while the window exceeds it.
  let first = 0
  let truncated = false
  for (; first < keep.length; first += 1) {
    const index = keep[first]
    const cost = scan.totalBytes - scan.userOffsets[index]
    if (cost <= budget) break
    truncated = true
  }
  if (first >= keep.length) first = keep.length - 1
  const startIndex = keep[first]
  return {
    startLine: scan.userLines[startIndex],
    truncated,
    droppedTurns: boundaries.length - (keep.length - first),
  }
}

/**
 * Second pass: normalize the records of the chosen window into plain items.
 * @param {string} path - rollout file.
 * @param {number} startLine - first line to read.
 * @param {{includeTools: boolean, toolResultMaxChars: number}} options - item policy.
 * @returns {Promise<object>} items and statistics.
 */
export async function readItems(path, startLine, options) {
  const items = []
  const unknown = new Map()
  let toolCalls = 0
  let model
  await eachLine(path, startLine, (line) => {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    const time = parseTime(record.timestamp)
    if (record.type === 'turn_context') {
      if (typeof record.payload?.model === 'string') model = record.payload.model
      return
    }
    if (record.type !== 'response_item') return
    const payload = record.payload
    if (payload === null || typeof payload !== 'object') return
    if (payload.type === 'message') {
      const role = payload.role
      if (role !== 'user' && role !== 'assistant') return
      const text = contentText(payload.content)
      if (text.trim() === '') return
      if (role === 'user' && !isConversationUserText(text)) return
      items.push({ kind: role, text, time })
      return
    }
    if (payload.type === 'reasoning') return
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (!options.includeTools) return
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      if (callId === undefined) return
      const name = typeof payload.name === 'string' ? payload.name : 'tool'
      const args = payload.type === 'custom_tool_call' ? payload.input : payload.arguments
      items.push({ kind: 'tool-call', callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}), time })
      toolCalls += 1
      return
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      if (!options.includeTools) return
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      if (callId === undefined) return
      let text = contentText(payload.output)
      if (text.length > options.toolResultMaxChars) {
        text = `${text.slice(0, options.toolResultMaxChars)}\n…（输出已截断）`
      }
      items.push({ kind: 'tool-output', callId, text, isError: payload.is_error === true, time })
      return
    }
    const key = `response_item:${String(payload.type)}`
    unknown.set(key, (unknown.get(key) ?? 0) + 1)
  })
  return { items, unknown, toolCalls, model }
}
