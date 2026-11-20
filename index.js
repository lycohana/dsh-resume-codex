/**
 * Host half of "Continue from Codex": two owner-only JSON routes that list the
 * local Codex rollouts and import one as a stored DSH session.
 *
 * Both routes ride the authenticated browser connection, so they are reachable
 * from the page and from nowhere else.
 *
 * @module dsh-resume-codex
 */

import { importCodexSession, CodexImportError, listCodexSessions } from './lib/importer.js'

/** Route listing selectable Codex sessions. */
export const LIST_PATH = '/api/resume-codex/sessions'
/** Route importing one Codex session. */
export const IMPORT_PATH = '/api/resume-codex/import'

/** Services this plugin needs from the host. */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry', 'sessions']

/** Clamp one numeric option. */
function integer(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Resolve the row config into explicit options. */
function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    codexHome: typeof source.codexHome === 'string' && source.codexHome.trim() !== '' ? source.codexHome.trim() : undefined,
    maxSessions: integer(source.maxSessions, 500, 1, 5000),
    maxTurns: integer(source.maxTurns, 30, 1, 500),
    maxChars: integer(source.maxChars, 240000, 1000, 40_000_000),
    maxFullChars: integer(source.maxFullChars, 4_000_000, 1000, 80_000_000),
    maxImportFileBytes: integer(source.maxImportFileBytes, 64 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
    toolResultMaxChars: integer(source.toolResultMaxChars, 12000, 200, 200_000),
  }
}

/** One JSON response. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Read one JSON request body, bounded by the carrier. */
async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** Validate the import request shape. */
function readImportRequest(body) {
  if (body === null || typeof body !== 'object') {
    return { error: 'missing request body' }
  }
  const { path, mode, maxTurns, includeTools, workspacePath } = body
  if (typeof path !== 'string' || path === '') return { error: 'path is required' }
  if (mode !== 'smart' && mode !== 'full') return { error: 'mode must be smart or full' }
  if (maxTurns !== undefined && (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns))) return { error: 'maxTurns must be a number' }
  if (includeTools !== undefined && typeof includeTools !== 'boolean') return { error: 'includeTools must be a boolean' }
  if (workspacePath !== undefined && (typeof workspacePath !== 'string' || workspacePath === '')) return { error: 'workspacePath must be a non-empty string' }
  return {
    value: {
      path,
      mode,
      maxTurns: maxTurns === undefined ? 30 : Math.min(500, Math.max(1, Math.floor(maxTurns))),
      includeTools: includeTools === true,
      workspacePath,
    },
  }
}

/**
 * Register the routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [config] - row config from the bundle patch.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const cache = new Map()
  const state = { active: false }

  ctx.effect(() => ctx.connection.fetch.register({
    path: LIST_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      try {
        const payload = await listCodexSessions(cache, options, { refresh: url.searchParams.get('refresh') === '1' })
        return json({ ok: true, ...payload })
      } catch (error) {
        ctx.logger?.warn?.('resume-codex: session list failed', error)
        return json({ ok: false, error: { reason: 'list-failed', message: error instanceof Error ? error.message : String(error) } }, 200)
      }
    },
  }), 'resume-codex: session list route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: IMPORT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson(request)
      const parsed = readImportRequest(body)
      if (parsed.error !== undefined) {
        return json({ ok: false, error: { reason: 'bad-request', message: parsed.error } }, 200)
      }
      if (state.active) {
        return json({ ok: false, error: { reason: 'busy', message: 'another import is running' } }, 200)
      }
      state.active = true
      try {
        const result = await importCodexSession(ctx, options, parsed.value, request.signal)
        return json({ ok: true, value: result })
      } catch (error) {
        if (request.signal.aborted) {
          return json({ ok: false, error: { reason: 'cancelled', message: 'the import was cancelled' } }, 200)
        }
        if (error instanceof CodexImportError) {
          return json({ ok: false, error: { reason: error.reason, message: error.message, detail: error.detail } }, 200)
        }
        ctx.logger?.error?.('resume-codex: import failed', error)
        return json({ ok: false, error: { reason: 'import-failed', message: error instanceof Error ? error.message : String(error) } }, 200)
      } finally {
        state.active = false
      }
    },
  }), 'resume-codex: import route')
}
