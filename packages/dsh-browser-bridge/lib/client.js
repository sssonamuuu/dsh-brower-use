/**
 * Browser half: registers a `@` source that lists the user's open tabs.
 *
 * This file is loaded by DSH's client module loader, which expects the
 * `window.__ModuleLoader__.load({ id, factory })` CJS-factory wrapper used by
 * shipped client bundles. The candidate list comes from the same-origin Host
 * route `/api/browser-bridge/tabs`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = typeof require === 'function' ? require('react') : null
    const SOURCE_NAME = 'browser-tab'
    const sectionCache = new Map()

    const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    const BROWSER_STYLES = [
      {
        test: /edge/i,
        name: 'Edge',
        emoji: '🌐',
        color: '#0f6cbd',
        logo: svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="e" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0cc0df"/><stop offset="1" stop-color="#0f6cbd"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#e)"/><text x="16" y="23" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="20" font-weight="700" fill="#fff">e</text></svg>'),
      },
      {
        test: /chrome|chromium/i,
        name: 'Chrome',
        emoji: '🌐',
        color: '#4285f4',
        logo: svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#fff"/><path fill="#EA4335" d="M16 1a15 15 0 0 1 12.99 7.5H16a7.5 7.5 0 0 0-6.5 3.76L4.1 4.6A14.96 14.96 0 0 1 16 1z"/><path fill="#34A853" d="M29 8.5A15 15 0 0 1 16 31l6.5-11.26A7.5 7.5 0 0 0 23 16c0-1.3-.33-2.53-.91-3.6H29z"/><path fill="#FBBC05" d="M16 31A15 15 0 0 1 4.1 4.6l6.5 11.26A7.5 7.5 0 0 0 16 23.5c1.3 0 2.53-.33 3.6-.91L16 31z"/><circle cx="16" cy="16" r="6.5" fill="#fff"/><circle cx="16" cy="16" r="4.5" fill="#4285F4"/></svg>'),
      },
      { test: /firefox/i, name: 'Firefox', emoji: '🦊', color: '#e66000' },
      { test: /safari/i, name: 'Safari', emoji: '🧭', color: '#006cff' },
      { test: /brave/i, name: 'Brave', emoji: '🦁', color: '#fb542b' },
    ]

    function browserStyle(brand) {
      const raw = String(brand ?? '').trim()
      const found = BROWSER_STYLES.find((entry) => entry.test.test(raw))
      return found ?? { name: raw || '浏览器', emoji: '🌐', color: '#6b7280' }
    }

    function sectionFor(brand) {
      const style = browserStyle(brand)
      const key = style.name
      if (!sectionCache.has(key)) {
        const label = `${style.name} 浏览器标签`
        const value = react && style.logo
          ? react.createElement(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              react.createElement('img', {
                src: style.logo,
                width: 12,
                height: 12,
                alt: '',
                style: { display: 'block', flex: 'none' },
              }),
              label,
            )
          : `${style.emoji} ${label}`
        sectionCache.set(key, value)
      }
      return sectionCache.get(key)
    }

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

    function shortLocation(rawUrl) {
      try {
        const url = new URL(rawUrl)
        const path = url.pathname === '/' ? '' : url.pathname
        const text = `${url.host}${path}`
        return text.length > 90 ? `${text.slice(0, 90)}…` : text
      } catch {
        return String(rawUrl ?? '').slice(0, 90)
      }
    }

    function flagsFor(tab) {
      return [
        tab.active ? '当前' : null,
        tab.windowId != null ? `窗口 ${tab.windowId}` : null,
        tab.pinned ? '已固定' : null,
        tab.discarded ? '已休眠' : null,
      ].filter(Boolean).join(' · ')
    }

    function colorFor(value) {
      const palette = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#4f46e5']
      let hash = 0
      const text = String(value ?? '')
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      return palette[hash % palette.length]
    }

    function faviconFor(tab) {
      const explicit = String(tab.favIconUrl ?? '')
      if (/^(https?:|data:image\/)/i.test(explicit)) return explicit
      try {
        const url = new URL(tab.url)
        if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}/favicon.ico`
      } catch {
        // fall through to the generated letter icon
      }
      return ''
    }

    function makeTabIcon(tab) {
      if (!react) return undefined
      const title = String(tab.title || tab.url || '?')
      const letter = title.trim().charAt(0).toUpperCase() || '?'
      const background = colorFor(tab.url || title)
      const favicon = faviconFor(tab)
      return function TabIcon({ size = 14 }) {
        return react.createElement(
          'span',
          {
            style: {
              position: 'relative',
              width: size,
              height: size,
              borderRadius: 3,
              background,
              color: '#fff',
              fontSize: Math.max(8, Math.round(size * 0.62)),
              fontWeight: 600,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flex: 'none',
            },
          },
          react.createElement('span', { 'aria-hidden': true }, letter),
          favicon
            ? react.createElement('img', {
                src: favicon,
                width: size,
                height: size,
                alt: '',
                loading: 'lazy',
                referrerPolicy: 'no-referrer',
                style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#fff' },
                onError: (event) => {
                  event.currentTarget.style.display = 'none'
                },
              })
            : null,
        )
      }
    }

    async function fetchTabs(signal) {
      const response = await fetch('/api/browser-bridge/tabs', {
        signal,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) return { tabs: [], browser: null }
      const data = await response.json().catch(() => null)
      return {
        tabs: Array.isArray(data?.tabs) ? data.tabs : [],
        browser: data?.browser ?? null,
      }
    }

    function apply(ctx) {
      const source = {
        trigger: '@',
        name: SOURCE_NAME,
        order: -10,
        showGroupTitle: false,
        async candidates(_session, { query, signal }) {
          if (signal?.aborted) return []
          let data
          try {
            data = await fetchTabs(signal)
          } catch {
            return []
          }
          const needle = String(query ?? '').trim().toLowerCase()
          return data.tabs
            .filter((tab) => {
              if (!needle) return true
              return `${tab.title ?? ''} ${tab.url ?? ''}`.toLowerCase().includes(needle)
            })
            .sort((left, right) => Number(right.active === true) - Number(left.active === true))
            .slice(0, 60)
            .map((tab) => {
              const title = tab.title?.trim() || tab.url || `tab ${tab.id}`
              const flags = flagsFor(tab)
              const browser = tab.browser || data.browser?.brand || data.browser?.browser || ''
              return {
                name: title.length > 90 ? `${title.slice(0, 90)}…` : title,
                description: `${shortLocation(tab.url)}${flags ? ` · ${flags}` : ''}`,
                section: sectionFor(browser),
                value: tabValue(tab),
                icon: makeTabIcon(tab),
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
