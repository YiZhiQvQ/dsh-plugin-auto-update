/**
 * dsh-plugin-update — Client half.
 *
 * Contributes to the Plugins page detail view instead of adding a page of its
 * own: a badge beside the title, an action button beside the page's own
 * switch/uninstall, and a small section under the page content.
 *
 *   GET  /plugin-update/state   cached report
 *   POST /plugin-update/check   { refresh?, names? }
 *   POST /plugin-update/update  { name }
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-update',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-plugin-update'
    const ENDPOINT = '/plugin-update'
    const CLIENT_HEADER = 'x-plugin-update'
    // Flip to true to print the detail page's `subject` in place of the section.
    const DEBUG_SUBJECT = false

    // ── dictionaries ────────────────────────────────────────────────────────
    const en = {
      check: 'Check for updates',
      checking: 'Checking…',
      update: 'Update to {version}',
      updating: 'Updating…',
      badgeNew: 'New version {version}',
      current: 'Up to date',
      sourceNpm: 'npm',
      sourceGit: 'Git repository',
      unsupportedLocal: 'Installed from a local package; no remote to compare against',
      unsupportedGitHost: 'This Git host publishes no manifest this bundle can read',
      unsupportedTarball: 'Installed from a tarball; no remote to compare against',
      unsupportedAlias: 'Installed from an alias; no remote to compare against',
      unsupportedUnknown: 'The install source is not a registry spec or a Git repository',
      failed: 'Could not read the remote version: {reason}',
      incompatible: 'Version {version} needs DSH {range} ({source}); this profile runs {runtime}',
      installed: 'Installed',
      latest: 'Newest',
      registry: 'Registry',
      checkedAt: 'Checked {time}',
      never: 'Not checked yet',
      updated: 'Updated {name} to {version}',
      updateFailed: 'Could not update {name}: {reason}',
      alreadyNewest: '{name} is already at the newest version',
      restartRequired: 'Restart DSH to finish loading {name}',
      disabledNote: 'This bundle is switched off; updating keeps it off',
      confirmTitle: 'Update {name}',
      confirmBody: 'The bundle is unloaded, reinstalled at {version}, and reloaded. Its saved configuration in the profile patch is kept.',
      confirmDanger: 'If the new version fails to start, the previous version is installed again.',
      confirmOk: 'Update',
      cancel: 'Cancel',
      sectionTitle: 'Updates',
      requestFailed: 'Request failed: {message}',
    }
    const zh = {
      check: '检查更新',
      checking: '正在检查…',
      update: '更新到 {version}',
      updating: '正在更新…',
      badgeNew: '有新版本 {version}',
      current: '已是最新',
      sourceNpm: 'npm',
      sourceGit: 'Git 仓库',
      unsupportedLocal: '本地包安装，没有可比对的远端',
      unsupportedGitHost: '这个 Git 托管站没有本插件能读取的清单文件',
      unsupportedTarball: '从压缩包安装，没有可比对的远端',
      unsupportedAlias: '通过别名安装，没有可比对的远端',
      unsupportedUnknown: '安装来源既不是 npm 仓库也不是 Git 仓库',
      failed: '无法读取远端版本：{reason}',
      incompatible: '最新版 {version} 要求 DSH {range}（{source}），当前运行的是 {runtime}',
      installed: '已安装',
      latest: '最新',
      registry: '仓库',
      checkedAt: '检查于 {time}',
      never: '尚未检查',
      updated: '已将 {name} 更新到 {version}',
      updateFailed: '更新 {name} 失败：{reason}',
      alreadyNewest: '{name} 已经是最新版本',
      restartRequired: '重启 DSH 后 {name} 才会生效',
      disabledNote: '该插件当前是关闭状态，更新后仍然保持关闭',
      confirmTitle: '更新 {name}',
      confirmBody: '插件会先被卸载，然后重新安装 {version} 并重新加载；profile 补丁里的配置会保留。',
      confirmDanger: '如果新版本启动失败，会自动装回原来的版本。',
      confirmOk: '更新',
      cancel: '取消',
      sectionTitle: '更新',
      requestFailed: '请求失败：{message}',
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
.dshpau-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.dshpau-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;white-space:nowrap}
.dshpau-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshpau-btn:disabled{opacity:.55;cursor:default}
.dshpau-btn.primary{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.dshpau-btn.primary:hover:not(:disabled){background:var(--dsw-alias-label-primary);opacity:.88}
.dshpau-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshpau-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshpau-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshpau-title{margin:0;font-size:13px;line-height:20px;font-weight:600}
.dshpau-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshpau-strong{color:var(--dsw-alias-label-primary);font-weight:600}
.dshpau-new{color:var(--dsw-alias-state-success-primary);font-weight:600}
.dshpau-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshpau-note.error{color:var(--dsw-alias-state-error-primary)}
.dshpau-spinner{width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-primary);animation:dshpau-spin .8s linear infinite}
@keyframes dshpau-spin{to{transform:rotate(360deg)}}
.dshpau-modalRoot{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.dshpau-modalMask{position:absolute;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(2px)}
.dshpau-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:18px;width:min(400px,100%);padding:22px 24px;border-radius:20px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary)}
.dshpau-dialogTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dshpau-dialogBody{margin:0;font-size:13px;line-height:20px}
.dshpau-dialogNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshpau-dialogFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshpau-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:14px;background:rgba(24,26,32,.94);color:#fff;font-size:14px;line-height:22px;box-shadow:0 12px 32px rgba(0,0,0,.32);transform:translateX(-50%)}
.dshpau-toastDot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.dshpau-toast.success .dshpau-toastDot{background:var(--dsw-alias-state-success-primary)}
.dshpau-toast.error .dshpau-toastDot{background:var(--dsw-alias-state-error-primary)}
.dshpau-toastText{min-width:0;overflow-wrap:anywhere}
.dshpau-debug{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
`

    // ── icons ───────────────────────────────────────────────────────────────
    function Icon({ path, size }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size ?? 14, height: size ?? 14,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, ...path.map((d, index) => h('path', { key: index, d })))
    }

    const GLYPH = {
      refresh: ['M13.6 8a5.6 5.6 0 1 1-1.7-4l1.7 1.7', 'M13.8 2.2v3.6h-3.6'],
      download: ['M8 2.2v8', 'M4.6 7.1L8 10.5l3.4-3.4', 'M2.8 13.2h10.4'],
    }

    function Spinner() {
      return h('span', { className: 'dshpau-spinner', 'aria-hidden': true })
    }

    // ── shared state ────────────────────────────────────────────────────────
    const store = {
      report: null,
      error: null,
      checking: false,
      updating: null,
      fetchedAt: 0,
      listeners: new Set(),
      t: (key) => key,
      toast: null,
      toastTimer: null,
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) {
          try {
            listener()
          } catch {
            // A broken subscriber must not stop the others.
          }
        }
      },
      translate(key, params) {
        let text
        try {
          text = store.t(key)
        } catch {
          text = key
        }
        if (typeof text !== 'string') text = key
        if (!params) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      },
      notify(text, kind) {
        this.toast = { text, kind: kind ?? 'info' }
        this.emit()
        if (this.toastTimer) clearTimeout(this.toastTimer)
        this.toastTimer = setTimeout(() => {
          this.toast = null
          this.toastTimer = null
          this.emit()
        }, 5200)
      },
      async request(method, action, body) {
        const init = { method, cache: 'no-store', headers: { accept: 'application/json' } }
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json'
          init.headers[CLIENT_HEADER] = '1'
          init.body = JSON.stringify(body)
        }
        const response = await fetch(`${ENDPOINT}/${action}`, init)
        let data
        try {
          data = await response.json()
        } catch {
          throw new Error(`HTTP ${response.status}`)
        }
        if (!data || typeof data !== 'object') throw new Error(`HTTP ${response.status}`)
        if (data.ok !== true) throw new Error(data.error || data.message || `HTTP ${response.status}`)
        return data
      },
      async load(force, names) {
        if (this.checking) return
        if (!force && this.report && Date.now() - this.fetchedAt < 3000) return
        this.checking = true
        this.error = null
        this.emit()
        try {
          const data = force
            ? await this.request('POST', 'check', names ? { refresh: true, names } : { refresh: true })
            : await this.request('GET', 'state')
          if (data.report) {
            this.report = data.report
            this.fetchedAt = Date.now()
          }
        } catch (error) {
          this.error = String((error && error.message) || error)
        } finally {
          this.checking = false
          this.emit()
        }
      },
      async update(name) {
        if (this.updating) {
          this.notify(this.translate('requestFailed', { message: 'another update is running' }), 'warn')
          return false
        }
        this.updating = name
        this.error = null
        this.emit()
        let ok = false
        try {
          const data = await this.request('POST', 'update', { name })
          const result = data.result ?? {}
          if (data.ok === true) {
            ok = true
            this.notify(this.translate('updated', { name, version: result.to ?? '' }), 'success')
            if (result.steps?.install?.application === 'restart-required') {
              this.notify(this.translate('restartRequired', { name }), 'warn')
            }
          } else if (result.upToDate === true) {
            // Not a failure: the remote simply matches what is installed.
            this.notify(this.translate('alreadyNewest', { name }), 'info')
          } else {
            const pending = Array.isArray(result.pendingBuilds) ? result.pendingBuilds : []
            const reason = pending.length > 0
              ? `${result.message ?? 'failed'} (${pending.join(', ')})`
              : (result.message || 'unknown')
            this.notify(this.translate('updateFailed', { name, reason }), 'error')
          }
          if (data.report) {
            this.report = data.report
            this.fetchedAt = Date.now()
          }
        } catch (error) {
          this.notify(this.translate('updateFailed', { name, reason: String((error && error.message) || error) }), 'error')
        } finally {
          this.updating = null
          this.emit()
        }
        return ok
      },
    }

    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])
      return store
    }

    // ── subject helpers ─────────────────────────────────────────────────────
    /**
     * The detail page's subject is `{ kind: 'bundle' | 'row' | 'official', pkg }`,
     * where `pkg` is the bundle row the page shows. Only a profile-installed
     * bundle can be updated, so every other subject renders nothing.
     */
    function bundleNameOf(subject) {
      if (!subject || typeof subject !== 'object') return undefined
      if (subject.kind !== 'bundle') return undefined
      const pkg = subject.pkg
      if (!pkg || typeof pkg !== 'object') return undefined
      if (pkg.installed !== true || pkg.availability !== 'profile') return undefined
      const name = pkg.name
      return typeof name === 'string' && name !== '' ? name : undefined
    }

    /** The row for one package, or `undefined` while the report lacks it. */
    function rowOf(report, name) {
      if (!report || !Array.isArray(report.rows)) return undefined
      return report.rows.find((row) => row.name === name)
    }

    function formatTime(value, locale) {
      if (!value) return ''
      try {
        return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return new Date(value).toLocaleTimeString()
      }
    }

    function activeLocale(store) {
      try {
        return store.localeService?.getSnapshot?.()?.active ?? undefined
      } catch {
        return undefined
      }
    }

    // ── contributions ───────────────────────────────────────────────────────
    function DetailBadge({ subject }) {
      const s = useStore()
      const name = bundleNameOf(subject)
      const row = rowOf(s.report, name)
      if (!row || row.status !== 'update') return null
      return h('span', { className: 'dshpau-badge' }, s.translate('badgeNew', { version: row.latest }))
    }

    function DetailActions({ subject }) {
      const s = useStore()
      const t = s.translate
      const [confirm, setConfirm] = React.useState(false)
      const name = bundleNameOf(subject)
      const row = rowOf(s.report, name)
      if (!name) return null

      // A bundle this profile does not own (an installation-provided one) has
      // nothing to update, so the entry stays out of the way. A Git source is
      // checkable: its remote manifest carries the version.
      const canCheck = row === undefined
        || row.kind === 'registry'
        || row.kind === 'git'
        || row.status === 'error'
      if (!canCheck) return null

      const busy = s.updating === name
      const checking = s.checking

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'dshpau-btn',
          disabled: checking || Boolean(s.updating),
          onClick: () => { void s.load(true, [name]) },
        }, checking ? h(Spinner) : h(Icon, { path: GLYPH.refresh }), checking ? t('checking') : t('check')),
        row && row.status === 'update'
          ? h('button', {
            type: 'button',
            className: 'dshpau-btn primary',
            disabled: busy || Boolean(s.updating),
            onClick: () => setConfirm(true),
          }, busy ? h(Spinner) : h(Icon, { path: GLYPH.download }), busy ? t('updating') : t('update', { version: row.latest }))
          : null,
        confirm
          ? h(ConfirmDialog, {
            name, version: row?.latest ?? '', t,
            onCancel: () => setConfirm(false),
            onConfirm: async () => {
              setConfirm(false)
              await s.update(name)
            },
          })
          : null,
      )
    }

    function DetailSection({ subject, debug }) {
      const s = useStore()
      const t = s.translate
      const name = bundleNameOf(subject)
      const row = rowOf(s.report, name)
      if (debug) {
        return h('div', { className: 'dshpau-section' },
          h('pre', { className: 'dshpau-debug' }, JSON.stringify(subject, null, 2)))
      }
      if (!row) return null
      if (row.status === 'current' && row.enabled !== false) {
        // Nothing to report: the page already shows the version and the switch.
        const origin = row.registry ? `${t('sourceNpm')} ${row.registry}` : row.remote ? `${t('sourceGit')} ${row.remote}` : ''
        return h('div', { className: 'dshpau-section' },
          h('div', { className: 'dshpau-row' },
            h(Icon, { path: GLYPH.refresh }),
            h('span', null, t('current')),
            h('span', null, `${t('latest')} ${row.latest ?? row.current ?? ''}`)),
          origin !== '' ? h('div', { className: 'dshpau-note' }, origin) : null,
          h('div', { className: 'dshpau-note' }, t('checkedAt', {
            time: formatTime(s.report?.checkedAt, activeLocale(s)),
          })))
      }
      return h('div', { className: 'dshpau-section' },
        h('div', { className: 'dshpau-head' },
          h('h3', { className: 'dshpau-title' }, t('sectionTitle')),
          row.registry
            ? h('span', { className: 'dshpau-note' }, `${t('registry')} ${row.registry}`)
            : row.remote
              ? h('span', { className: 'dshpau-note' }, `${t('sourceGit')} ${row.remote}`)
              : null,
        ),
        h('div', { className: 'dshpau-row' },
          h('span', null, `${t('installed')} ${row.current ?? '?'}`),
          row.latest ? h('span', { 'aria-hidden': true }, '→') : null,
          row.latest
            ? h('span', { className: row.status === 'update' ? 'dshpau-new' : 'dshpau-strong' },
              `${t('latest')} ${row.latest}`)
            : null,
        ),
        row.status === 'unsupported'
          ? h('div', { className: 'dshpau-note' }, t({
            local: 'unsupportedLocal',
            'git-unreadable': 'unsupportedGitHost',
            tarball: 'unsupportedTarball',
            alias: 'unsupportedAlias',
          }[row.kind] ?? 'unsupportedUnknown'))
          : null,
        row.status === 'error'
          ? h('div', { className: 'dshpau-note error' }, t('failed', { reason: row.reason ?? '' }))
          : null,
        row.status === 'incompatible'
          ? h('div', { className: 'dshpau-note' }, t('incompatible', {
            version: row.latest ?? '',
            range: row.requirement?.range ?? '',
            source: row.requirement?.source ?? '',
            runtime: s.report?.runtimeVersion ?? '',
          }))
          : null,
        row.enabled === false && row.status !== 'unsupported'
          ? h('div', { className: 'dshpau-note' }, t('disabledNote'))
          : null,
      )
    }

    function ConfirmDialog({ name, version, t, onCancel, onConfirm }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKey)
        try {
          ref.current?.focus()
        } catch {
          // Focus is a nicety; the dialog still works.
        }
        return () => document.removeEventListener('keydown', onKey)
      }, [onCancel])
      return h('div', { className: 'dshpau-modalRoot', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('confirmTitle', { name }) },
        h('div', { className: 'dshpau-modalMask', onClick: onCancel }),
        h('div', { className: 'dshpau-dialog' },
          h('h2', { className: 'dshpau-dialogTitle' }, t('confirmTitle', { name })),
          h('p', { className: 'dshpau-dialogBody' }, t('confirmBody', { version })),
          h('p', { className: 'dshpau-dialogNote' }, t('confirmDanger')),
          h('div', { className: 'dshpau-dialogFooter' },
            h('button', { type: 'button', className: 'dshpau-btn', onClick: onCancel }, t('cancel')),
            h('button', { type: 'button', className: 'dshpau-btn primary', onClick: onConfirm, ref }, t('confirmOk')),
          ),
        ),
      )
    }

    function Toast({ store }) {
      const s = useStore()
      if (!s.toast) return null
      return h('div', { className: `dshpau-toast ${s.toast.kind}` },
        h('span', { className: 'dshpau-toastDot', 'aria-hidden': true }),
        h('span', { className: 'dshpau-toastText' }, s.toast.text))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        store.t = ctx.locale.bind(NS)
        store.localeService = ctx.get('locale')
        const tKey = (key) => {
          try {
            return store.t(key)
          } catch {
            return key
          }
        }

        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'plugin-update: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'plugin-update: zh dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-plugin-update', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'plugin-update: styles')

        ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
          name: 'plugins.detail.badge',
          id: 'dsh-plugin-update',
          order: 10,
        }, DetailBadge))

        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'dsh-plugin-update',
          order: 10,
        }, DetailActions))

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-plugin-update',
          order: 10,
        }, (props) => DetailSection({ ...props, debug: DEBUG_SUBJECT })))

        // The badge and the buttons read the cached report; load it once so a
        // detail page opened before the Host finished its warm check is right.
        ctx.effect(() => {
          const timer = setTimeout(() => {
            if (!store.report && !store.checking) void store.load(false)
          }, 2500)
          return () => clearTimeout(timer)
        }, 'plugin-update: warm check')
      },
    }
  },
})
