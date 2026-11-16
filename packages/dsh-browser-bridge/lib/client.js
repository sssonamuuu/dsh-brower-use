/**
 * Browser half: registers a `@` source that lists the user's open tabs.
 *
 * This file is loaded by DSH's client module loader, which expects the
 * `window.__ModuleLoader__.load({ id, factory })` CJS-factory wrapper used by
 * shipped client bundles. The candidate list comes from the same-origin Host
 * route `/api/browser-bridge/tabs`.
 */
window.__ModuleLoader__.load({
  id: '@sssonamuuu/dsh-browser-bridge',
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
        name: "Edge",
        color: "#0f6cbd",
        logo: svgUri("<svg fill=\"#0f6cbd\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M21.86 17.86q.14 0 .25.12.1.13.1.25t-.11.33l-.32.46-.43.53-.44.5q-.21.25-.38.42l-.22.23q-.58.53-1.34 1.04-.76.51-1.6.91-.86.4-1.74.64t-1.67.24q-.9 0-1.69-.28-.8-.28-1.48-.78-.68-.5-1.22-1.17-.53-.66-.92-1.44-.38-.77-.58-1.6-.2-.83-.2-1.67 0-1 .32-1.96.33-.97.87-1.8.14.95.55 1.77.41.82 1.02 1.5.6.68 1.38 1.21.78.54 1.64.9.86.36 1.77.56.92.2 1.8.2 1.12 0 2.18-.24 1.06-.23 2.06-.72l.2-.1.2-.05zm-15.5-1.27q0 1.1.27 2.15.27 1.06.78 2.03.51.96 1.24 1.77.74.82 1.66 1.4-1.47-.2-2.8-.74-1.33-.55-2.48-1.37-1.15-.83-2.08-1.9-.92-1.07-1.58-2.33T.36 14.94Q0 13.54 0 12.06q0-.81.32-1.49.31-.68.83-1.23.53-.55 1.2-.96.66-.4 1.35-.66.74-.27 1.5-.39.78-.12 1.55-.12.7 0 1.42.1.72.12 1.4.35.68.23 1.32.57.63.35 1.16.83-.35 0-.7.07-.33.07-.65.23v-.02q-.63.28-1.2.74-.57.46-1.05 1.04-.48.58-.87 1.26-.38.67-.65 1.39-.27.71-.42 1.44-.15.72-.15 1.38zM11.96.06q1.7 0 3.33.39 1.63.38 3.07 1.15 1.43.77 2.62 1.93 1.18 1.16 1.98 2.7.49.94.76 1.96.28 1 .28 2.08 0 .89-.23 1.7-.24.8-.69 1.48-.45.68-1.1 1.22-.64.53-1.45.88-.54.24-1.11.36-.58.13-1.16.13-.42 0-.97-.03-.54-.03-1.1-.12-.55-.1-1.05-.28-.5-.19-.84-.5-.12-.09-.23-.24-.1-.16-.1-.33 0-.15.16-.35.16-.2.35-.5.2-.28.36-.68.16-.4.16-.95 0-1.06-.4-1.96-.4-.91-1.06-1.64-.66-.74-1.52-1.28-.86-.55-1.79-.89-.84-.3-1.72-.44-.87-.14-1.76-.14-1.55 0-3.06.45T.94 7.55q.71-1.74 1.81-3.13 1.1-1.38 2.52-2.35Q6.68 1.1 8.37.58q1.7-.52 3.58-.52Z\"/></svg>"),
      },
      {
        test: /chrome|chromium/i,
        name: "Chrome",
        color: "#4285f4",
        logo: svgUri("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><circle cx=\"16\" cy=\"16\" r=\"15\" fill=\"#fff\"/><path fill=\"#EA4335\" d=\"M16 1a15 15 0 0 1 12.99 7.5H16a7.5 7.5 0 0 0-6.5 3.76L4.1 4.6A14.96 14.96 0 0 1 16 1z\"/><path fill=\"#34A853\" d=\"M29 8.5A15 15 0 0 1 16 31l6.5-11.26A7.5 7.5 0 0 0 23 16c0-1.3-.33-2.53-.91-3.6H29z\"/><path fill=\"#FBBC05\" d=\"M16 31A15 15 0 0 1 4.1 4.6l6.5 11.26A7.5 7.5 0 0 0 16 23.5c1.3 0 2.53-.33 3.6-.91L16 31z\"/><circle cx=\"16\" cy=\"16\" r=\"6.5\" fill=\"#fff\"/><circle cx=\"16\" cy=\"16\" r=\"4.5\" fill=\"#4285F4\"/></svg>"),
      },
      {
        test: /firefox/i,
        name: "Firefox",
        color: "#ff7139",
        logo: svgUri("<svg fill=\"#ff7139\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20.452 3.445a11.002 11.002 0 00-2.482-1.908C16.944.997 15.098.093 12.477.032c-.734-.017-1.457.03-2.174.144-.72.114-1.398.292-2.118.56-1.017.377-1.996.975-2.574 1.554.583-.349 1.476-.733 2.55-.992a10.083 10.083 0 013.729-.167c2.341.34 4.178 1.381 5.48 2.625a8.066 8.066 0 011.298 1.587c1.468 2.382 1.33 5.376.184 7.142-.85 1.312-2.67 2.544-4.37 2.53-.583-.023-1.438-.152-2.25-.566-2.629-1.343-3.021-4.688-1.118-6.306-.632-.136-1.82.13-2.646 1.363-.742 1.107-.7 2.816-.242 4.028a6.473 6.473 0 01-.59-1.895 7.695 7.695 0 01.416-3.845A8.212 8.212 0 019.45 5.399c.896-1.069 1.908-1.72 2.75-2.005-.54-.471-1.411-.738-2.421-.767C8.31 2.583 6.327 3.061 4.7 4.41a8.148 8.148 0 00-1.976 2.414c-.455.836-.691 1.659-.697 1.678.122-1.445.704-2.994 1.248-4.055-.79.413-1.827 1.668-2.41 3.042C.095 9.37-.2 11.608.14 13.989c.966 5.668 5.9 9.982 11.843 9.982C18.62 23.971 24 18.591 24 11.956a11.93 11.93 0 00-3.548-8.511z\"/></svg>"),
      },
      {
        test: /brave/i,
        name: "Brave",
        color: "#fb542b",
        logo: svgUri("<svg fill=\"#fb542b\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15.68 0l2.096 2.38s1.84-.512 2.709.358c.868.87 1.584 1.638 1.584 1.638l-.562 1.381.715 2.047s-2.104 7.98-2.35 8.955c-.486 1.919-.818 2.66-2.198 3.633-1.38.972-3.884 2.66-4.293 2.916-.409.256-.92.692-1.38.692-.46 0-.97-.436-1.38-.692a185.796 185.796 0 01-4.293-2.916c-1.38-.973-1.712-1.714-2.197-3.633-.247-.975-2.351-8.955-2.351-8.955l.715-2.047-.562-1.381s.716-.768 1.585-1.638c.868-.87 2.708-.358 2.708-.358L8.321 0h7.36zm-3.679 14.936c-.14 0-1.038.317-1.758.69-.72.373-1.242.637-1.409.742-.167.104-.065.301.087.409.152.107 2.194 1.69 2.393 1.866.198.175.489.464.687.464.198 0 .49-.29.688-.464.198-.175 2.24-1.759 2.392-1.866.152-.108.254-.305.087-.41-.167-.104-.689-.368-1.41-.741-.72-.373-1.617-.69-1.757-.69zm0-11.278s-.409.001-1.022.206-1.278.46-1.584.46c-.307 0-2.581-.434-2.581-.434S4.119 7.152 4.119 7.849c0 .697.339.881.68 1.243l2.02 2.149c.192.203.59.511.356 1.066-.235.555-.58 1.26-.196 1.977.384.716 1.042 1.194 1.464 1.115.421-.08 1.412-.598 1.776-.834.364-.237 1.518-1.19 1.518-1.554 0-.365-1.193-1.02-1.413-1.168-.22-.15-1.226-.725-1.247-.95-.02-.227-.012-.293.284-.851.297-.559.831-1.304.742-1.8-.089-.495-.95-.753-1.565-.986-.615-.232-1.799-.671-1.947-.74-.148-.068-.11-.133.339-.175.448-.043 1.719-.212 2.292-.052.573.16 1.552.403 1.632.532.079.13.149.134.067.579-.081.445-.5 2.581-.541 2.96-.04.38-.12.63.288.724.409.094 1.097.256 1.333.256s.924-.162 1.333-.256c.408-.093.329-.344.288-.723-.04-.38-.46-2.516-.541-2.961-.082-.445-.012-.45.067-.579.08-.129 1.059-.372 1.632-.532.573-.16 1.845.009 2.292.052.449.042.487.107.339.175-.148.069-1.332.508-1.947.74-.615.233-1.476.49-1.565.986-.09.496.445 1.241.742 1.8.297.558.304.624.284.85-.02.226-1.026.802-1.247.95-.22.15-1.413.804-1.413 1.169 0 .364 1.154 1.317 1.518 1.554.364.236 1.355.755 1.776.834.422.079 1.08-.4 1.464-1.115.384-.716.039-1.422-.195-1.977-.235-.555.163-.863.355-1.066l2.02-2.149c.341-.362.68-.546.68-1.243 0-.697-2.695-3.96-2.695-3.96s-2.274.436-2.58.436c-.307 0-.972-.256-1.585-.461-.613-.205-1.022-.206-1.022-.206z\"/></svg>"),
      },
      {
        test: /opera/i,
        name: "Opera",
        color: "#ff1b2d",
        logo: svgUri("<svg fill=\"#ff1b2d\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M8.051 5.238c-1.328 1.566-2.186 3.883-2.246 6.48v.564c.061 2.598.918 4.912 2.246 6.479 1.721 2.236 4.279 3.654 7.139 3.654 1.756 0 3.4-.537 4.807-1.471C17.879 22.846 15.074 24 12 24c-.192 0-.383-.004-.57-.014C5.064 23.689 0 18.436 0 12 0 5.371 5.373 0 12 0h.045c3.055.012 5.84 1.166 7.953 3.055-1.408-.93-3.051-1.471-4.81-1.471-2.858 0-5.417 1.42-7.14 3.654h.003zM24 12c0 3.556-1.545 6.748-4.002 8.945-3.078 1.5-5.946.451-6.896-.205 3.023-.664 5.307-4.32 5.307-8.74 0-4.422-2.283-8.075-5.307-8.74.949-.654 3.818-1.703 6.896-.205C22.455 5.25 24 8.445 24 12z\"/></svg>"),
      },
      {
        test: /vivaldi/i,
        name: "Vivaldi",
        color: "#ef3939",
        logo: svgUri("<svg fill=\"#ef3939\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 0C6.75 0 3.817 0 1.912 1.904.007 3.81 0 6.75 0 12s0 8.175 1.912 10.08C3.825 23.985 6.75 24 12 24c5.25 0 8.183 0 10.088-1.904C23.993 20.19 24 17.25 24 12s0-8.175-1.912-10.08C20.175.015 17.25 0 12 0zm-.168 3a9 9 0 016.49 2.648 9 9 0 010 12.704A9 9 0 1111.832 3zM7.568 7.496a1.433 1.433 0 00-.142.004A1.5 1.5 0 006.21 9.75l1.701 3c.93 1.582 1.839 3.202 2.791 4.822a1.417 1.417 0 001.41.75 1.5 1.5 0 001.223-.81l4.447-7.762A1.56 1.56 0 0018 8.768a1.5 1.5 0 10-2.828.914 2.513 2.513 0 01.256 1.119v.246a2.393 2.393 0 01-2.52 2.13 2.348 2.348 0 01-1.965-1.214c-.307-.51-.6-1.035-.9-1.553-.42-.72-.826-1.41-1.246-2.16a1.433 1.433 0 00-1.229-.754Z\"/></svg>"),
      },
    ]

    function browserStyle(brand) {
      const raw = String(brand ?? '').trim()
      const found = BROWSER_STYLES.find((entry) => entry.test.test(raw))
      return found ?? { name: raw || '浏览器', color: '#6b7280', unknown: true }
    }

    function letterBadge(text, background, size = 12) {
      const letter = String(text ?? '').trim().charAt(0).toUpperCase() || '?'
      return react.createElement(
        'span',
        {
          style: {
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
            flex: 'none',
          },
        },
        letter,
      )
    }

    function sectionFor(brand) {
      const style = browserStyle(brand)
      const key = style.name
      if (!sectionCache.has(key)) {
        const label = style.unknown ? '浏览器标签' : `${style.name} 浏览器标签`
        const icon = react
          ? style.logo
            ? react.createElement('img', {
                src: style.logo,
                width: 12,
                height: 12,
                alt: '',
                style: { display: 'block', flex: 'none' },
              })
            : letterBadge(style.name === '浏览器' ? '?' : style.name, style.color, 12)
          : null
        const value = react
          ? react.createElement(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              icon,
              label,
            )
          : `${style.name} 浏览器标签`
        sectionCache.set(key, value)
      }
      return sectionCache.get(key)
    }

    function tabValue(tab) {
      return JSON.stringify({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '', browser: tab.browser ?? '' })
    }

    function browserKeyOf(tab, fallback = '') {
      const style = browserStyle(tab.browser || fallback)
      return style.name.toLocaleLowerCase()
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
          // Keep each browser's tabs contiguous so its section heading is
          // rendered once; active tabs lead inside each browser group.
          const fallbackBrowser = data.browser?.brand || data.browser?.browser || ''
          const browserOrder = new Map()
          for (const tab of data.tabs) {
            const key = browserKeyOf(tab, fallbackBrowser)
            if (!browserOrder.has(key)) browserOrder.set(key, browserOrder.size)
          }
          return data.tabs
            .filter((tab) => {
              if (!needle) return true
              return `${tab.title ?? ''} ${tab.url ?? ''}`.toLowerCase().includes(needle)
            })
            .sort((left, right) => {
              const leftGroup = browserOrder.get(browserKeyOf(left, fallbackBrowser)) ?? 0
              const rightGroup = browserOrder.get(browserKeyOf(right, fallbackBrowser)) ?? 0
              if (leftGroup !== rightGroup) return leftGroup - rightGroup
              const active = Number(right.active === true) - Number(left.active === true)
              if (active !== 0) return active
              return (Number(left.windowId) - Number(right.windowId)) || (Number(left.index) - Number(right.index))
            })
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
