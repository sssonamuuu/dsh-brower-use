/**
 * Browser half: registers a `@` source that lists the user's open tabs.
 *
 * This file is loaded by DSH's client module loader, which expects the
 * `window.__ModuleLoader__.load({ id, factory })` CJS-factory wrapper used by
 * shipped client bundles. It has no imports: the candidate list comes from the
 * same-origin Host route `/api/browser-bridge/tabs`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-bridge',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    const SOURCE_NAME = 'browser-tab'
    const SECTION = '浏览器标签页'

    function tabValue(tab) {
      return JSON.stringify({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '' })
    }

    function parseValue(value) {
      try {
        const parsed = JSON.parse(value)
        return parsed && Number.isFinite(Number(parsed.id)) ? parsed : null
      } catch {
        return null
      }
    }

    function serialize(ref) {
      const tab = parseValue(ref)
      if (!tab) return String(ref ?? '')
      const title = tab.title || tab.url || `tab ${tab.id}`
      return `[Browser tab id=${tab.id}] ${title} — ${tab.url}`
    }

    async function fetchTabs(signal) {
      const response = await fetch('/api/browser-bridge/tabs', {
        signal,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) return []
      const data = await response.json().catch(() => null)
      return Array.isArray(data?.tabs) ? data.tabs : []
    }

    function apply(ctx) {
      const source = {
        trigger: '@',
        name: SOURCE_NAME,
        order: -10,
        showGroupTitle: false,
        async candidates(_session, { query, signal }) {
          if (signal?.aborted) return []
          let tabs
          try {
            tabs = await fetchTabs(signal)
          } catch {
            return []
          }
          const needle = String(query ?? '').trim().toLowerCase()
          return tabs
            .filter((tab) => {
              if (!needle) return true
              return `${tab.title ?? ''} ${tab.url ?? ''}`.toLowerCase().includes(needle)
            })
            .slice(0, 60)
            .map((tab) => {
              const title = tab.title?.trim() || tab.url || `tab ${tab.id}`
              const flags = [
                tab.active ? 'active' : null,
                tab.windowId != null ? `win ${tab.windowId}` : null,
                tab.discarded ? 'discarded' : null,
              ].filter(Boolean).join(' · ')
              return {
                name: title.length > 90 ? `${title.slice(0, 90)}…` : title,
                description: `${tab.url ?? ''}${flags ? ` · ${flags}` : ''}`,
                section: SECTION,
                value: tabValue(tab),
              }
            })
        },
        onPick({ candidate }) {
          const tab = parseValue(candidate?.value)
          if (!tab) return { text: '' }
          return {
            insert: {
              source: SOURCE_NAME,
              ref: candidate.value,
              label: tab.title?.trim() || tab.url || `tab ${tab.id}`,
              clipboardText: serialize(candidate.value),
            },
          }
        },
        openReference() {
          return false
        },
        codec: {
          clipboardText: (ref) => serialize(ref),
          serialize: (ref) => Promise.resolve(serialize(ref)),
        },
      }
      const inputTriggers = ctx.get('inputTriggers')
      ctx.effect(() => inputTriggers.registerSource(source), 'browser-tabs: @ source')
    }

    const inject = ['inputTriggers']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
