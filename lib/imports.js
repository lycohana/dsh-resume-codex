/**
 * Local import registry: which Codex rollout produced which DSH session.
 *
 * Kept as one small JSON file under the DSH plugin-data directory so the picker
 * can mark already imported sessions and the import stays idempotent per
 * rollout without touching the Codex home.
 *
 * @module dsh-resume-codex/imports
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Directory holding this plugin's own data. */
export function dataDirectory() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'resume-codex')
}

/** Path of the import registry file. */
export function registryPath() {
  return join(dataDirectory(), 'imports.json')
}

/**
 * Read the registry.
 * @returns {Promise<Record<string, {sessionId: string, title?: string, at: number}>>} path → import facts.
 */
export async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [path, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object') continue
      if (typeof value.sessionId !== 'string' || value.sessionId === '') continue
      out[path] = {
        sessionId: value.sessionId,
        title: typeof value.title === 'string' ? value.title : undefined,
        at: typeof value.at === 'number' ? value.at : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Record one rollout → session mapping, replacing an older mapping atomically.
 * @param {string} rolloutPath - Codex rollout file.
 * @param {string} sessionId - imported DSH session.
 * @param {string} title - imported title.
 * @returns {Promise<void>}
 */
export async function rememberImport(rolloutPath, sessionId, title) {
  const registry = await readRegistry()
  registry[rolloutPath] = { sessionId, title, at: Date.now() }
  const target = registryPath()
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}
