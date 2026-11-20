/**
 * Browser half of "Continue from Codex".
 *
 * Registers one compact option in the New Session row. The option opens a
 * native <dialog> (top layer, so the scroll body cannot clip it) listing the
 * local Codex rollouts; importing one creates a stored DSH Session in the
 * rollout's working directory and opens it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-resume-codex',
  factory(require) {
    const React = require('react')
    const { Fragment, useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'resumeCodex'

    const zh = {
      'action.label': '从 Codex 继续',
      'action.hint': '选择一个 Codex 会话，在它的工作目录里继续',
      'dialog.title': '从 Codex 继续',
      'dialog.search': '搜索标题、目录或模型',
      'dialog.all': '全部',
      'dialog.here': '当前目录',
      'dialog.loading': '正在读取 Codex 会话…',
      'dialog.empty': '没有找到 Codex 会话',
      'dialog.emptyHint': '已检查 {home}',
      'dialog.retry': '重试',
      'dialog.refresh': '重新扫描',
      'dialog.range': '导入范围',
      'dialog.rangeSmart': '智能（摘要 + 最近 30 轮）',
      'dialog.rangeSmartShort': '智能 30 轮',
      'dialog.rangeRecent': '摘要 + 最近 50 轮',
      'dialog.rangeRecentShort': '最近 50 轮',
      'dialog.rangeFull': '全部对话',
      'dialog.rangeFullShort': '全部',
      'dialog.tools': '包含工具调用',
      'dialog.toolsHint': '命令与输出会作为历史记录导入',
      'dialog.importing': '正在导入…',
      'dialog.importingHint': '正在写入会话与工作区',
      'dialog.import': '继续',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.importFailed': '导入失败：{message}',
      'dialog.openFailed': '已导入会话，但打开失败：{message}',
      'dialog.importedBadge': '已导入',
      'dialog.toolsCount': '{count} 次工具调用',
      'dialog.noTitle': '未命名会话',
      'error.codex-home-missing': '没有找到 Codex 会话目录。',
      'error.source-missing': '所选会话文件不存在或不在 Codex 目录中。',
      'error.source-too-large': '会话文件过大，无法导入。',
      'error.seed-invalid': '生成的会话历史未通过校验：{detail}',
      'error.write-failed': '写入会话失败：{detail}',
      'error.workspace-missing': 'Codex 原工作目录不存在，且没有可用的替代目录。',
      'error.workspace-failed': '会话已写入，但工作区登记失败：{detail}',
      'error.no-user-message': '该会话没有可导入的用户消息。',
      'error.empty-transcript': '该会话没有可导入的内容。',
      'error.busy': '已有另一个导入正在进行。',
      'error.cancelled': '导入已取消。',
      'error.bad-request': '请求无效：{detail}',
      'error.import-failed': '导入失败：{message}',
      'error.list-failed': '读取 Codex 会话失败：{message}',
      'error.unknown': '导入失败。',
    }

    const en = {
      'action.label': 'Continue from Codex',
      'action.hint': 'Pick a Codex session and continue in its working directory',
      'dialog.title': 'Continue from Codex',
      'dialog.search': 'Search title, directory or model',
      'dialog.all': 'All',
      'dialog.here': 'This directory',
      'dialog.loading': 'Reading Codex sessions…',
      'dialog.empty': 'No Codex session found',
      'dialog.emptyHint': 'Looked in {home}',
      'dialog.retry': 'Retry',
      'dialog.refresh': 'Rescan',
      'dialog.range': 'Import scope',
      'dialog.rangeSmart': 'Smart (summary + last 30 turns)',
      'dialog.rangeSmartShort': 'Smart 30',
      'dialog.rangeRecent': 'Summary + last 50 turns',
      'dialog.rangeRecentShort': 'Last 50',
      'dialog.rangeFull': 'Full conversation',
      'dialog.rangeFullShort': 'All',
      'dialog.tools': 'Include tool calls',
      'dialog.toolsHint': 'Commands and their output join the history',
      'dialog.importing': 'Importing…',
      'dialog.importingHint': 'Writing the session and its workspace',
      'dialog.import': 'Continue',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.importFailed': 'Import failed: {message}',
      'dialog.openFailed': 'The session was imported but could not be opened: {message}',
      'dialog.importedBadge': 'Imported',
      'dialog.toolsCount': '{count} tool calls',
      'dialog.noTitle': 'Untitled session',
      'error.codex-home-missing': 'No Codex session directory was found.',
      'error.source-missing': 'That session file is missing or outside the Codex home.',
      'error.source-too-large': 'That session file is too large to import.',
      'error.seed-invalid': 'The generated history failed validation: {detail}',
      'error.write-failed': 'Writing the session failed: {detail}',
      'error.workspace-missing': 'The Codex working directory is gone and no fallback directory exists.',
      'error.workspace-failed': 'The session was written but its workspace could not be registered: {detail}',
      'error.no-user-message': 'That session has no importable user message.',
      'error.empty-transcript': 'That session has no importable content.',
      'error.busy': 'Another import is already running.',
      'error.cancelled': 'The import was cancelled.',
      'error.bad-request': 'Invalid request: {detail}',
      'error.import-failed': 'Import failed: {message}',
      'error.list-failed': 'Reading Codex sessions failed: {message}',
      'error.unknown': 'Import failed.',
    }

    const iconPrompt = (size) => h('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
      'aria-hidden': true, style: { display: 'block' },
    }, h('path', {
      d: 'M3.2 4.1 7 8l-3.8 3.9', stroke: 'currentColor', strokeWidth: 1.6,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }), h('path', {
      d: 'M8.6 11.9h4.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
    }))

    const iconClose = h('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    }, h('path', {
      d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
    }))

    const CSS = `
.rc-trigger{display:inline-flex;flex:none;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;
  border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}
@media(hover:hover){.rc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.rc-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.rc-dialog{box-sizing:border-box;position:fixed;inset:0;margin:auto;display:flex;flex-direction:column;gap:20px;
  width:min(680px,calc(100vw - 48px));max-width:calc(100vw - 48px);max-height:min(calc(100dvh - 48px),760px);
  padding:0 0 24px;border:0;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-alias-bg-layer-2,#2c2c2e);
  color:var(--dsw-alias-label-primary,#f9fafb);box-shadow:var(--dsw-elevation-prominent,0 24px 64px rgba(0,0,0,.5));
  font-family:inherit;font-size:14px;line-height:22px;overflow:hidden}
.rc-dialog::backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:var(--dsw-mask-blur,blur(6px))}
.rc-dialog:not([open]){display:none}
.rc-dialog:focus{outline:none}
.rc-row:focus-visible,.rc-btn:focus-visible,.rc-icon-btn:focus-visible,.rc-seg button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.rc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.rc-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rc-icon-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;
  border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
@media(hover:hover){.rc-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.rc-icon-btn:disabled{opacity:.4;cursor:default}
.rc-body{display:flex;flex-direction:column;gap:12px;min-height:0;padding:0 24px}
.rc-toolbar{display:flex;align-items:center;gap:8px}
.rc-search{box-sizing:border-box;flex:1;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);
  border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;line-height:20px;outline:none}
.rc-search::placeholder{color:var(--dsw-alias-label-dimmed)}
.rc-search:focus{border-color:var(--dsw-alias-state-business-primary)}
.rc-seg{display:inline-flex;flex:none;padding:3px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1)}
.rc-seg button{height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.rc-seg button[data-active="1"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.rc-seg button:disabled{opacity:.4;cursor:default}
.rc-list{flex:1;min-height:160px;max-height:min(48vh,440px);overflow:auto;overscroll-behavior:contain;margin:0 -12px}
.rc-row{display:block;box-sizing:border-box;width:100%;text-align:left;border:0;border-radius:var(--dsw-radius-md,12px);
  background:transparent;color:inherit;padding:10px 12px;cursor:pointer;font:inherit}
@media(hover:hover){.rc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.rc-row[data-active="1"]{background:var(--dsw-alias-interactive-bg-active)}
.rc-row-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-row-meta{display:flex;align-items:center;gap:8px;margin-top:2px;min-width:0;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.rc-row-cwd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px}
.rc-row-tag{flex:none;padding:0 6px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.rc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:200px;
  padding:24px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px;line-height:20px}
.rc-empty strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}
.rc-error{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:16px 12px;
  color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.rc-options{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.rc-field{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.rc-check{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;
  cursor:pointer;user-select:none}
.rc-check input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.rc-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.rc-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.rc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;
  min-width:72px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,12px);cursor:pointer;
  font:inherit;font-size:14px;line-height:22px;white-space:nowrap;background:transparent;color:var(--dsw-alias-label-primary)}
.rc-btn[data-kind="outline"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
@media(hover:hover){.rc-btn[data-kind="outline"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.rc-btn[data-kind="primary"]{background:var(--dsw-alias-button-primary-fill,#f9fafb);color:var(--dsw-alias-label-primary-foreground,#0f1115)}
@media(hover:hover){.rc-btn[data-kind="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#fff)}}
.rc-btn:disabled{opacity:.4;cursor:not-allowed}
.rc-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);
  border-top-color:var(--dsw-alias-label-primary);animation:rc-spin .8s linear infinite;flex:none}
@keyframes rc-spin{to{transform:rotate(360deg)}}
.rc-import-state{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
`

    const RANGE_SMART = 'smart30'
    const RANGE_RECENT = 'smart50'
    const RANGE_FULL = 'full'

    const formatDate = (value) => {
      try {
        return new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
      } catch {
        return new Date(value).toLocaleString()
      }
    }

    const formatSize = (bytes) => {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      return `${Math.max(1, Math.round(bytes / 1024))} KB`
    }

    const pathKey = (value) => String(value ?? '').replace(/[\\/]+/g, '/').toLowerCase()

    async function requestJson(path, init) {
      const response = await fetch(new URL(path, document.baseURI), {
        credentials: 'same-origin',
        ...init,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body === null || body.ok !== true) {
        const failure = new Error(body?.error?.message ?? 'request failed')
        failure.reason = body?.error?.reason ?? 'unknown'
        failure.detail = body?.error?.detail
        throw failure
      }
      return body
    }

    /**
     * The New Session row option plus its picker dialog.
     * @param props - slot props: sessionId, useWorkspaces, and the injected API.
     */
    function ContinueFromCodex(props) {
      const { sessionId, useWorkspaces, translate } = props
      const t = typeof translate === 'function' ? (key, params) => translate(key, params) : key => key
      const useWorkspacesSafe = typeof useWorkspaces === 'function' ? useWorkspaces : () => undefined
      const dialogRef = useRef(null)
      const searchRef = useRef(null)
      const [open, setOpen] = useState(false)
      const [phase, setPhase] = useState('idle')
      const [sessions, setSessions] = useState([])
      const [home, setHome] = useState(null)
      const [diagnostics, setDiagnostics] = useState([])
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [scope, setScope] = useState('all')
      const [selected, setSelected] = useState(null)
      const [range, setRange] = useState(RANGE_SMART)
      const [includeTools, setIncludeTools] = useState(false)
      const [importing, setImporting] = useState(false)
      const [importError, setImportError] = useState(null)

      const currentPath = useWorkspacesSafe(state => {
        const items = state?.items ?? []
        for (const item of items) {
          if (Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) return item.path
        }
        return undefined
      })

      const load = useCallback(async (refresh) => {
        setPhase('loading')
        setError(null)
        try {
          const body = await requestJson(`/api/resume-codex/sessions${refresh ? '?refresh=1' : ''}`)
          const list = Array.isArray(body.sessions) ? body.sessions : []
          setSessions(list)
          setSelected(previous => (previous !== null && list.some(session => session.path === previous) ? previous : null))
          setHome(body.codexHome ?? null)
          setDiagnostics(Array.isArray(body.diagnostics) ? body.diagnostics : [])
          setPhase('ready')
        } catch (failure) {
          setError(failure)
          setPhase('error')
        }
      }, [])

      useEffect(() => {
        const dialog = dialogRef.current
        if (dialog === null) return undefined
        if (open && !dialog.open) {
          dialog.showModal()
          void load(true)
        } else if (!open && dialog.open) {
          dialog.close()
        }
        return undefined
      }, [open, load])

      useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => { searchRef.current?.focus() }, 30)
        return () => { clearTimeout(timer) }
      }, [open])

      const close = () => {
        if (importing) return
        setOpen(false)
      }

      const filtered = sessions.filter((session) => {
        if (scope === 'cwd' && currentPath !== undefined && pathKey(session.cwd) !== pathKey(currentPath)) return false
        if (query.trim() !== '') {
          const needle = query.trim().toLowerCase()
          const haystack = `${session.title}\n${session.cwd ?? ''}\n${session.model ?? ''}`.toLowerCase()
          if (!haystack.includes(needle)) return false
        }
        return true
      })

      const selectedSession = sessions.find(session => session.path === selected)

      const runImport = async () => {
        if (selected === null || importing) return
        setImporting(true)
        setImportError(null)
        try {
          const body = await requestJson('/api/resume-codex/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path: selected,
              mode: range === RANGE_FULL ? 'full' : 'smart',
              maxTurns: range === RANGE_RECENT ? 50 : 30,
              includeTools,
              workspacePath: currentPath,
            }),
          })
          const sessionIdCreated = body.value?.sessionId
          if (typeof sessionIdCreated !== 'string') throw new Error('missing session id')
          try {
            await props.openImportedSession(sessionIdCreated)
          } catch (failure) {
            setImportError({ reason: 'open', message: t('dialog.openFailed', { message: failure instanceof Error ? failure.message : String(failure) }) })
            setImporting(false)
            return
          }
          setImporting(false)
          setOpen(false)
        } catch (failure) {
          const reason = failure?.reason ?? 'unknown'
          const detail = failure?.detail ?? (failure instanceof Error ? failure.message : String(failure))
          const key = `error.${reason}`
          const message = t(key, { detail: detail ?? '', message: detail ?? '' })
          setImportError({ reason, message: message === key ? t('error.unknown') : message })
          setImporting(false)
        }
      }

      const scopeAvailable = currentPath !== undefined && currentPath !== ''

      return h(Fragment, null,
        h('button', {
          type: 'button',
          className: 'rc-trigger',
          title: t('action.label'),
          'aria-label': t('action.label'),
          onClick: () => { setOpen(true) },
        }, iconPrompt(15), h('span', null, t('action.label'))),
        h('dialog', {
          ref: dialogRef,
          className: 'rc-dialog',
          'aria-label': t('dialog.title'),
          onClose: () => { if (!importing) setOpen(false) },
          onCancel: (event) => { if (importing) event.preventDefault() },
          onClick: (event) => { if (event.target === event.currentTarget && !importing) setOpen(false) },
        },
        h('style', null, CSS),
        h('div', { className: 'rc-head' },
          h('h2', { className: 'rc-title' }, t('dialog.title')),
          h('button', {
            type: 'button', className: 'rc-icon-btn', title: t('dialog.close'),
            'aria-label': t('dialog.close'), onClick: close, disabled: importing,
          }, iconClose)),
        h('div', { className: 'rc-body' },
          h('div', { className: 'rc-toolbar' },
            h('input', {
              ref: searchRef,
              className: 'rc-search',
              type: 'search',
              placeholder: t('dialog.search'),
              value: query,
              disabled: importing,
              onChange: (event) => { setQuery(event.target.value) },
            }),
            scopeAvailable ? h('div', { className: 'rc-seg', role: 'tablist' },
              h('button', {
                type: 'button', role: 'tab', 'data-active': scope === 'all' ? '1' : '0',
                'aria-selected': scope === 'all', onClick: () => { setScope('all') }, disabled: importing,
              }, t('dialog.all')),
              h('button', {
                type: 'button', role: 'tab', 'data-active': scope === 'cwd' ? '1' : '0',
                'aria-selected': scope === 'cwd', onClick: () => { setScope('cwd') }, disabled: importing,
              }, t('dialog.here'))) : null),
          h('div', { className: 'rc-list' },
            phase === 'loading' ? h('div', { className: 'rc-empty' },
              h('div', { className: 'rc-import-state' }, h('span', { className: 'rc-spinner' }), h('span', null, t('dialog.loading'))))
              : phase === 'error' ? h('div', { className: 'rc-error' },
                h('div', null, t(`error.${error?.reason ?? 'list-failed'}`, { message: error?.message ?? '' })),
                h('button', { type: 'button', className: 'rc-btn', 'data-kind': 'outline', onClick: () => { void load(true) } }, t('dialog.retry')))
                : filtered.length === 0 ? h('div', { className: 'rc-empty' },
                  h('strong', null, t('dialog.empty')),
                  h('div', null, t('dialog.emptyHint', { home: home ?? '~/.codex' })),
                  diagnostics.length > 0 ? h('div', null, diagnostics[0]) : null,
                  h('button', { type: 'button', className: 'rc-btn', 'data-kind': 'outline', onClick: () => { void load(true) } }, t('dialog.refresh')))
                  : filtered.map(session => h('button', {
                    key: session.path,
                    type: 'button',
                    className: 'rc-row',
                    'data-active': selected === session.path ? '1' : '0',
                    onClick: () => { setSelected(session.path) },
                    disabled: importing,
                  },
                  h('div', { className: 'rc-row-title' }, session.title !== '' ? session.title : t('dialog.noTitle')),
                  h('div', { className: 'rc-row-meta' },
                    h('span', { className: 'rc-row-cwd' }, session.cwd ?? '—'),
                    h('span', null, '·'),
                    h('span', null, formatDate(session.updatedAt)),
                    formatSize(session.size) !== '' ? h('span', null, '·') : null,
                    formatSize(session.size) !== '' ? h('span', null, formatSize(session.size)) : null,
                    session.model !== undefined ? h('span', null, '·') : null,
                    session.model !== undefined ? h('span', null, session.model) : null,
                    session.importedSessionId !== undefined
                      ? h('span', { className: 'rc-row-tag' }, t('dialog.importedBadge'))
                      : null)))),
          h('div', { className: 'rc-options' },
            h('div', { className: 'rc-field' },
              h('span', null, t('dialog.range')),
              h('div', { className: 'rc-seg rc-seg-range', role: 'group', 'aria-label': t('dialog.range') },
                h('button', {
                  type: 'button', 'data-active': range === RANGE_SMART ? '1' : '0',
                  'aria-pressed': range === RANGE_SMART, title: t('dialog.rangeSmart'),
                  onClick: () => { setRange(RANGE_SMART) }, disabled: importing,
                }, t('dialog.rangeSmartShort')),
                h('button', {
                  type: 'button', 'data-active': range === RANGE_RECENT ? '1' : '0',
                  'aria-pressed': range === RANGE_RECENT, title: t('dialog.rangeRecent'),
                  onClick: () => { setRange(RANGE_RECENT) }, disabled: importing,
                }, t('dialog.rangeRecentShort')),
                h('button', {
                  type: 'button', 'data-active': range === RANGE_FULL ? '1' : '0',
                  'aria-pressed': range === RANGE_FULL, title: t('dialog.rangeFull'),
                  onClick: () => { setRange(RANGE_FULL) }, disabled: importing,
                }, t('dialog.rangeFullShort')))),
            h('label', { className: 'rc-check', title: t('dialog.toolsHint') },
              h('input', {
                type: 'checkbox', checked: includeTools, disabled: importing,
                onChange: (event) => { setIncludeTools(event.target.checked) },
              }),
              h('span', null, t('dialog.tools'))))),
        h('div', { className: 'rc-foot' },
          importing
            ? h('div', { className: 'rc-note' }, h('span', { className: 'rc-import-state' }, h('span', { className: 'rc-spinner' }), h('span', null, t('dialog.importing'))))
            : importError !== null
              ? h('div', { className: 'rc-note', style: { color: 'var(--dsw-alias-state-error-primary)' }, title: importError.message }, importError.message)
              : h('div', { className: 'rc-note', title: selectedSession?.cwd ?? '' }, selectedSession?.cwd ?? ''),
          h('button', { type: 'button', className: 'rc-btn', 'data-kind': 'outline', onClick: close, disabled: importing }, t('dialog.cancel')),
          h('button', {
            type: 'button', className: 'rc-btn', 'data-kind': 'primary',
            disabled: selected === null || importing,
            onClick: () => { void runImport() },
          }, importing ? t('dialog.importing') : t('dialog.import')))))
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'resume-codex: dictionaries')
        const translate = (key, params) => {
          try {
            return ctx.locale.bind(NS)(key, params)
          } catch {
            return key
          }
        }
        const injected = {
          translate,
          openImportedSession: async (sessionId) => {
            await ctx.sessions.refresh()
            ctx.uiWorkspace.openSession(sessionId)
          },
        }
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'resume-codex',
          order: 10,
          inject: () => injected,
        }, ContinueFromCodex))
      },
    }
  },
})
