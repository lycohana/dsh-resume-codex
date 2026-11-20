/**
 * Import one Codex rollout as a stored DSH session in the rollout's workspace.
 *
 * The session is written through the same primitives the official DeepSeek chat
 * import uses: a seed validated by the session store, a persistence handle that
 * appends the seed and flushes it, a projection-cache refresh, and a Workspace
 * membership. No Codex file is modified.
 *
 * @module dsh-resume-codex/importer
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import {
  chooseWindow,
  listRolloutFiles,
  readHead,
  readItems,
  resolveCodexHome,
  scanRollout,
} from './codex.js'
import { convertTranscript } from './convert.js'
import { readRegistry, rememberImport } from './imports.js'

/** Failure with a stable reason the browser maps to copy. */
export class CodexImportError extends Error {
  /**
   * @param {string} reason - stable failure reason.
   * @param {string} message - diagnostic for the browser.
   * @param {string} [detail] - optional extra detail, such as a validation error.
   */
  constructor(reason, message, detail) {
    super(message)
    this.name = 'CodexImportError'
    this.reason = reason
    this.detail = detail
  }
}

/** Whether one path is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether one path is a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Resolve the Codex home or fail with the reason the browser shows. */
async function requireHome(options) {
  const home = await resolveCodexHome(options.codexHome)
  if (home === undefined) {
    throw new CodexImportError(
      'codex-home-missing',
      'no Codex home with a sessions directory was found',
      options.codexHome ?? process.env.CODEX_HOME ?? '~/.codex',
    )
  }
  return home
}

/**
 * Whether one file lives under a Codex sessions tree.
 * @param {string} file - candidate rollout path.
 * @param {string} home - canonical Codex home.
 * @returns {Promise<boolean>} true only for files under sessions or archived_sessions.
 */
async function insideCodexHome(file, home) {
  let canonical
  try {
    canonical = await realpath(file)
  } catch {
    return false
  }
  const roots = [join(home, 'sessions'), join(home, 'archived_sessions')]
  for (const root of roots) {
    let canonicalRoot
    try {
      canonicalRoot = await realpath(root)
    } catch {
      canonicalRoot = root
    }
    if (canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${sep}`)) return true
  }
  return false
}

/**
 * List selectable Codex sessions, most recently updated first.
 * @param {Map<string, object>} cache - per-file head cache owned by the plugin.
 * @param {object} options - resolved plugin options.
 * @param {{refresh?: boolean}} request - whether to re-read every head.
 * @returns {Promise<object>} list payload.
 */
export async function listCodexSessions(cache, options, request) {
  const home = await resolveCodexHome(options.codexHome)
  if (home === undefined) {
    return {
      codexHome: null,
      sessions: [],
      diagnostics: [`未找到 Codex 会话目录（${options.codexHome ?? process.env.CODEX_HOME ?? '~/.codex'}）。`],
    }
  }
  const diagnostics = []
  const registry = await readRegistry()
  const files = await listRolloutFiles(home)
  const sessions = []
  for (const file of files) {
    if (sessions.length >= options.maxSessions) break
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    const cached = cache.get(file)
    let head
    if (request.refresh !== true && cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      head = cached.head
    } else {
      try {
        head = await readHead(file)
      } catch (error) {
        diagnostics.push(`跳过无法读取的会话：${basename(file)}（${error instanceof Error ? error.message : String(error)}）`)
        continue
      }
      cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, head })
    }
    sessions.push({
      ...head,
      updatedAt: Math.round(head.updatedAt),
      path: file,
      importedSessionId: registry[file]?.sessionId,
      importedAt: registry[file]?.at,
    })
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  if (diagnostics.length > 20) diagnostics.length = 20
  return { codexHome: home, sessions, diagnostics }
}

/**
 * Pick the directory the imported session runs in.
 * @param {object} ctx - plugin context.
 * @param {string | undefined} codexCwd - Codex session working directory.
 * @param {string | undefined} requested - workspace directory chosen in the dialog.
 * @returns {Promise<string>} absolute existing directory.
 */
async function pickWorkspaceDirectory(ctx, codexCwd, requested) {
  const candidates = []
  if (typeof codexCwd === 'string' && isAbsolute(codexCwd)) candidates.push(codexCwd)
  if (typeof requested === 'string' && isAbsolute(requested)) candidates.push(requested)
  const fallback = ctx.get('workingDirectory')?.defaultDirectory
  if (typeof fallback === 'string' && isAbsolute(fallback)) candidates.push(fallback)
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return resolve(candidate)
  }
  throw new CodexImportError(
    'workspace-missing',
    'the Codex working directory no longer exists and no other workspace was available',
    codexCwd ?? requested ?? '',
  )
}

/**
 * Import one rollout into a stored Session and its Workspace.
 * @param {object} ctx - plugin context with `sessionPersistence`, `workspaceRegistry` and `sessions`.
 * @param {object} options - resolved plugin options.
 * @param {{path: string, mode: 'smart'|'full', maxTurns: number, includeTools: boolean, workspacePath?: string}} request - validated request.
 * @param {AbortSignal} signal - cancellation of the request.
 * @returns {Promise<object>} import result.
 * @throws {CodexImportError} for every expected failure.
 */
export async function importCodexSession(ctx, options, request, signal) {
  const startedAt = Date.now()
  signal.throwIfAborted()
  const home = await requireHome(options)
  const file = resolve(String(request.path ?? ''))
  if (!file.endsWith('.jsonl') || !(await isFile(file)) || !(await insideCodexHome(file, home))) {
    throw new CodexImportError('source-missing', 'the selected rollout file is not a readable Codex session', request.path)
  }
  const size = (await stat(file)).size
  if (size > options.maxImportFileBytes) {
    throw new CodexImportError('source-too-large', `the rollout is ${size} bytes; the limit is ${options.maxImportFileBytes}`, String(size))
  }
  signal.throwIfAborted()

  const head = await readHead(file)
  const scan = await scanRollout(file)
  const window = chooseWindow(scan, {
    mode: request.mode,
    maxTurns: request.maxTurns,
    maxChars: request.mode === 'full' ? options.maxFullChars : options.maxChars,
  })
  const summary = request.mode === 'smart' ? scan.compaction?.summary : undefined
  const parsed = await readItems(file, window.startLine, {
    includeTools: request.includeTools === true,
    toolResultMaxChars: options.toolResultMaxChars,
  })
  signal.throwIfAborted()

  const warnings = []
  if (request.mode === 'full' && window.truncated) {
    warnings.push('会话超出单次导入上限，已从最早的部分截断。')
  }
  if (request.mode === 'smart' && window.truncated) {
    warnings.push(`会话较长，已保留最近 ${request.maxTurns} 轮中的可用部分。`)
  }
  if (request.mode === 'smart' && scan.compactions > 0 && scan.compaction === undefined) {
    warnings.push('Codex 的压缩摘要为加密格式，已跳过摘要，仅导入对话消息。')
  } else if (request.mode === 'smart' && scan.compaction !== undefined && scan.lastCompactionLine > scan.compaction.line) {
    warnings.push('Codex 较新的压缩摘要为加密格式，已改用上一份可读摘要，并保留其后的完整消息。')
  }
  if (head.cwd !== undefined && !(await isDirectory(head.cwd))) {
    warnings.push(`Codex 原工作目录已不存在：${head.cwd}，已改用可用工作区。`)
  }
  const workspacePath = await pickWorkspaceDirectory(ctx, head.cwd, request.workspacePath)

  const title = head.title !== '' ? head.title : `Codex ${basename(workspacePath)}`
  const conversion = convertTranscript({
    items: parsed.items,
    summary,
    title,
    createdAt: head.createdAt,
    model: scan.model ?? head.model ?? parsed.model,
    includeTools: request.includeTools === true,
    toolResultMaxChars: options.toolResultMaxChars,
  })
  if (conversion.events.length === 0) {
    throw new CodexImportError('empty-transcript', 'the selected rollout produced no importable events')
  }

  // Validate the seed through the live session store before any bytes are
  // written; the same call supplies the storage format version.
  const id = randomUUID()
  let prepared
  try {
    prepared = ctx.sessions.prepare(id, {
      seed: conversion.events,
      meta: { cwd: workspacePath, createdAt: head.createdAt, isSeeded: false },
    })
  } catch (error) {
    throw new CodexImportError(
      'seed-invalid',
      'the generated session history failed validation',
      error instanceof Error ? error.message : String(error),
    )
  }
  const header = prepared.header

  signal.throwIfAborted()
  let handle
  try {
    handle = await ctx.sessionPersistence.create(header, { signal })
  } catch (error) {
    throw new CodexImportError(
      'write-failed',
      'the session could not be created in storage',
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    await handle.append(conversion.events, { signal })
    await handle.flush({ signal })
  } catch (error) {
    throw new CodexImportError(
      'write-failed',
      'the session could not be written to storage',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    await handle.close().catch(() => undefined)
  }

  const projectionCache = ctx.get('sessionProjectionCache')
  if (projectionCache !== undefined && typeof projectionCache?.coldSnapshot === 'function') {
    try {
      projectionCache.coldSnapshot(header, 0, conversion.events)
    } catch (error) {
      ctx.logger?.warn?.('resume-codex: session list projection refresh failed', error)
    }
  }

  let workspace
  try {
    workspace = await ctx.workspaceRegistry.resolveByPath(workspacePath)
  } catch {
    workspace = undefined
  }
  if (workspace === undefined) {
    try {
      workspace = await ctx.workspaceRegistry.create(workspacePath)
    } catch (error) {
      throw new CodexImportError(
        'workspace-failed',
        'the session was written but its workspace could not be registered',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  try {
    await workspace.attachSession(id)
  } catch (error) {
    throw new CodexImportError(
      'workspace-failed',
      'the session was written but could not be added to its workspace',
      error instanceof Error ? error.message : String(error),
    )
  }

  await rememberImport(file, id, title).catch(() => undefined)

  return {
    sessionId: id,
    workspaceId: workspace.id,
    workspacePath,
    title,
    mode: request.mode,
    includeTools: request.includeTools === true,
    summaryIncluded: typeof summary === 'string' && summary.trim() !== '',
    truncated: window.truncated,
    droppedTurns: window.droppedTurns,
    stats: conversion.stats,
    skippedTypes: [...parsed.unknown.keys()],
    toolCalls: parsed.toolCalls,
    warnings,
    elapsedMs: Date.now() - startedAt,
  }
}
