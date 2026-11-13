/**
 * MAIN world collector.
 *
 * Runs at document_start, before page scripts, and hooks the page's own
 * console/fetch/XHR APIs. It cannot call chrome.runtime directly; events are
 * posted to the isolated relay via window.postMessage.
 *
 * The guard makes repeated chrome.scripting.executeScript injections safe.
 */
(() => {
  if (window.__DSH_COLLECTOR__) return
  try {
    Object.defineProperty(window, '__DSH_COLLECTOR__', { value: true, enumerable: false, configurable: false })
  } catch {
    window.__DSH_COLLECTOR__ = true
  }

  const CHANNEL = 'dsh-browser-collector'
  const MAX_BODY = 256 * 1024
  const MAX_TEXT = 8000
  let seq = 0
  let requestSeq = 0

  function post(type, data) {
    try {
      window.postMessage({ __dsh: CHANNEL, type, seq: ++seq, ts: Date.now(), data }, '*')
    } catch {
      // a page may have replaced postMessage; dropping an event is preferable to breaking the page
    }
  }

  function clip(text, max) {
    const value = String(text ?? '')
    return value.length > max ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]` : value
  }

  function safe(value, depth = 0, seen = new WeakSet()) {
    if (value === undefined) return '[undefined]'
    if (value === null) return null
    const type = typeof value
    if (type === 'string') return clip(value, 4000)
    if (type === 'number' || type === 'boolean') return value
    if (type === 'bigint') return `${value}n`
    if (type === 'symbol') return value.toString()
    if (type === 'function') return `[Function ${value.name || 'anonymous'}]`
    if (depth > 4) return '[depth limit]'
    if (seen.has(value)) return '[Circular]'
    try {
      if (value instanceof Error) {
        return { name: value.name, message: clip(value.message, 2000), stack: clip(value.stack, 4000) }
      }
      if (typeof Node !== 'undefined' && value instanceof Node) {
        const id = value.id ? `#${value.id}` : ''
        const cls = typeof value.className === 'string' && value.className ? `.${value.className.split(/\s+/).slice(0, 3).join('.')}` : ''
        return `<${String(value.nodeName).toLowerCase()}${id}${cls}>`
      }
      if (value instanceof Date) return value.toISOString()
      if (value instanceof RegExp) return String(value)
      if (typeof Map !== 'undefined' && value instanceof Map) {
        seen.add(value)
        return [...value.entries()].slice(0, 50).map(([key, item]) => [safe(key, depth + 1, seen), safe(item, depth + 1, seen)])
      }
      if (typeof Set !== 'undefined' && value instanceof Set) {
        seen.add(value)
        return [...value.values()].slice(0, 50).map((item) => safe(item, depth + 1, seen))
      }
      if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) {
        return `[${value.constructor?.name || 'Binary'} ${value.byteLength} bytes]`
      }
      if (Array.isArray(value)) {
        seen.add(value)
        const items = value.slice(0, 50).map((item) => safe(item, depth + 1, seen))
        if (value.length > 50) items.push(`… ${value.length - 50} more`)
        return items
      }
      seen.add(value)
      const result = {}
      let keys = []
      try {
        keys = Object.keys(value)
      } catch {
        return '[object]'
      }
      for (const key of keys.slice(0, 40)) {
        try {
          result[key] = safe(value[key], depth + 1, seen)
        } catch (error) {
          result[key] = `[getter threw: ${error instanceof Error ? error.message : String(error)}]`
        }
      }
      if (keys.length > 40) result['…'] = `${keys.length - 40} more keys`
      return result
    } catch (error) {
      return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`
    }
  }

  function formatArg(value) {
    if (typeof value === 'string') return clip(value, 4000)
    const serialized = safe(value)
    if (typeof serialized === 'string') return serialized
    if (serialized === undefined) return String(value)
    try {
      return JSON.stringify(serialized)
    } catch {
      return String(serialized)
    }
  }

  function stackFor(level) {
    if (level !== 'error' && level !== 'warn') return undefined
    try {
      const stack = new Error().stack || ''
      const lines = stack.split('\n').filter((line) => !/dsh-browser-collector|content\/collector\.js|chrome-extension:\/\//.test(line))
      return clip(lines.slice(1).join('\n'), 4000) || undefined
    } catch {
      return undefined
    }
  }

  function installConsole() {
    if (!window.console) return
    const levels = ['log', 'info', 'warn', 'error', 'debug']
    for (const level of levels) {
      const original = window.console[level]
      if (typeof original !== 'function') continue
      window.console[level] = function dshConsole(...args) {
        try {
          const safeArgs = args.map((arg) => safe(arg))
          post('console', {
            level,
            args: safeArgs,
            text: clip(args.map(formatArg).join(' '), MAX_TEXT),
            ...(stackFor(level) ? { stack: stackFor(level) } : {}),
          })
        } catch {
          // never fail the page's console call
        }
        return original.apply(this, args)
      }
    }
    // console.trace is useful for debugging but semantically a debug entry.
    const trace = window.console.trace
    if (typeof trace === 'function') {
      window.console.trace = function dshTrace(...args) {
        try {
          post('console', {
            level: 'debug',
            args: args.map((arg) => safe(arg)),
            text: `console.trace ${clip(args.map(formatArg).join(' '), MAX_TEXT)}`,
            stack: stackFor('error'),
          })
        } catch {
          // ignore
        }
        return trace.apply(this, args)
      }
    }
  }

  function installErrors() {
    window.addEventListener('error', (event) => {
      try {
        if (!event.message && !event.error) return // resource load error; not a JS exception
        const location = event.filename ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : ''
        post('console', {
          level: 'error',
          args: [safe(event.error ?? event.message)],
          text: clip(`${event.message || 'Uncaught error'}${location ? ` (${location})` : ''}`, MAX_TEXT),
          stack: clip(event.error?.stack ?? location, 4000),
          ...(location ? { url: event.filename } : {}),
        })
      } catch {
        // ignore
      }
    }, true)
    window.addEventListener('unhandledrejection', (event) => {
      try {
        const reason = event.reason
        const message = reason instanceof Error ? reason.message : formatArg(reason)
        post('console', {
          level: 'error',
          args: [safe(reason)],
          text: clip(`Unhandled rejection: ${message}`, MAX_TEXT),
          stack: clip(reason instanceof Error ? reason.stack : '', 4000),
        })
      } catch {
        // ignore
      }
    })
  }

  function headersToObject(headers) {
    if (!headers) return undefined
    try {
      const result = {}
      let count = 0
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          if (count++ < 50) result[key] = clip(value, 1000)
        })
      } else if (typeof headers === 'object') {
        for (const key of Object.keys(headers).slice(0, 50)) result[key] = clip(headers[key], 1000)
      }
      return result
    } catch {
      return undefined
    }
  }

  function textLike(contentType) {
    const type = String(contentType || '').toLowerCase()
    return !type || /json|text|javascript|xml|x-www-form-urlencoded|graphql|html/.test(type)
  }

  async function readResponseBody(response, contentType) {
    if (!textLike(contentType)) return null
    if (response.type === 'opaque' || response.type === 'opaqueredirect') return null
    const clone = response.clone()
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY * 2) {
      return { body: null, truncated: true, size: contentLength }
    }
    const reader = clone.body?.getReader?.()
    if (!reader) {
      const text = await clone.text()
      return { body: clip(text, MAX_BODY), truncated: text.length > MAX_BODY, size: text.length }
    }
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    let truncated = false
    const deadline = setTimeout(() => {
      try {
        reader.cancel().catch(() => {})
      } catch {
        // ignore
      }
    }, 2500)
    try {
      while (bytes < MAX_BODY) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value?.byteLength ?? 0
        text += decoder.decode(value, { stream: true })
        if (text.length >= MAX_BODY) {
          truncated = true
          break
        }
      }
      text += decoder.decode()
      await reader.cancel().catch(() => {})
    } catch {
      return { body: text ? clip(text, MAX_BODY) : null, truncated: true, size: bytes }
    } finally {
      clearTimeout(deadline)
    }
    return { body: clip(text, MAX_BODY), truncated: truncated || text.length > MAX_BODY, size: bytes }
  }

  function installFetch() {
    if (typeof window.fetch !== 'function') return
    const originalFetch = window.fetch
    window.fetch = function dshFetch(input, init) {
      const id = `r${++requestSeq}`
      const started = performance.now()
      let url = ''
      let method = 'GET'
      let requestHeaders
      let requestBody
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url
          method = (input.method || 'GET').toUpperCase()
          requestHeaders = headersToObject(input.headers)
        } else {
          url = String(input)
          method = (init?.method || 'GET').toUpperCase()
          requestHeaders = headersToObject(init?.headers)
        }
        try { url = new URL(url, location.href).href } catch { /* keep as given */ }
        if (init && typeof init.body === 'string') requestBody = clip(init.body, 4096)
      } catch {
        // malformed input; the original fetch will report the real error
      }
      post('network.request', { id, method, url, type: 'fetch', requestHeaders, ...(requestBody ? { body: requestBody } : {}) })
      return originalFetch.apply(this, arguments).then(
        (response) => {
          try {
            const contentType = response.headers.get('content-type') || ''
            post('network.response', {
              id,
              status: response.status,
              statusText: response.statusText,
              responseHeaders: headersToObject(response.headers),
              mimeType: contentType,
              durationMs: Math.round((performance.now() - started) * 10) / 10,
              url: response.url || url,
            })
            if (textLike(contentType)) {
              readResponseBody(response, contentType).then((result) => {
                if (!result) return
                post('network.body', { id, body: result.body ?? undefined, truncated: result.truncated, size: result.size })
              }).catch(() => {})
            }
          } catch {
            // ignore
          }
          return response
        },
        (error) => {
          post('network.error', {
            id,
            message: error instanceof Error ? error.message : String(error),
            durationMs: Math.round((performance.now() - started) * 10) / 10,
          })
          throw error
        },
      )
    }
    try {
      Object.defineProperty(window.fetch, 'name', { value: 'fetch' })
    } catch {
      // ignore
    }
  }

  function installXhr() {
    if (typeof XMLHttpRequest === 'undefined') return
    const proto = XMLHttpRequest.prototype
    const originalOpen = proto.open
    const originalSend = proto.send
    const originalSetHeader = proto.setRequestHeader
    proto.open = function dshOpen(method, url, async, user, password) {
      this.__dsh = {
        id: `r${++requestSeq}`,
        method: String(method || 'GET').toUpperCase(),
        url: (() => { try { return new URL(String(url || ''), location.href).href } catch { return String(url || '') } })(),
        headers: {},
        started: 0,
        bound: false,
      }
      return originalOpen.apply(this, arguments)
    }
    proto.setRequestHeader = function dshSetHeader(key, value) {
      try {
        if (this.__dsh && Object.keys(this.__dsh.headers).length < 50) this.__dsh.headers[key] = clip(value, 1000)
      } catch {
        // ignore
      }
      return originalSetHeader.apply(this, arguments)
    }
    proto.send = function dshSend(body) {
      const meta = this.__dsh || { id: `r${++requestSeq}`, method: 'GET', url: '', headers: {}, bound: false }
      this.__dsh = meta
      meta.started = performance.now()
      meta.body = typeof body === 'string' ? clip(body, 4096) : undefined
      post('network.request', {
        id: meta.id,
        method: meta.method,
        url: meta.url,
        type: 'xhr',
        requestHeaders: meta.headers,
        ...(meta.body ? { body: meta.body } : {}),
      })
      if (!meta.bound) {
        meta.bound = true
        this.addEventListener('loadend', () => {
          try {
            const durationMs = Math.round((performance.now() - meta.started) * 10) / 10
            if (this.status === 0 && (this.statusText === '' || this.readyState === 4)) {
              post('network.error', { id: meta.id, message: this.statusText || 'XHR failed (status 0)' })
              return
            }
            post('network.response', {
              id: meta.id,
              status: this.status,
              statusText: this.statusText,
              responseHeaders: parseXhrHeaders(this.getAllResponseHeaders()),
              mimeType: this.getResponseHeader('content-type') || '',
              durationMs,
              url: this.responseURL || meta.url,
            })
            let text = null
            if (this.responseType === '' || this.responseType === 'text') {
              text = this.responseText
            } else if (this.responseType === 'json' && this.response) {
              try {
                text = JSON.stringify(this.response)
              } catch {
                text = null
              }
            }
            if (typeof text === 'string' && text.length > 0) {
              post('network.body', {
                id: meta.id,
                body: clip(text, MAX_BODY),
                truncated: text.length > MAX_BODY,
                size: text.length,
              })
            }
          } catch {
            // ignore
          }
        })
      }
      return originalSend.apply(this, arguments)
    }
  }

  function parseXhrHeaders(raw) {
    const result = {}
    try {
      for (const line of String(raw || '').trim().split(/[\r\n]+/)) {
        const index = line.indexOf(':')
        if (index > 0) result[line.slice(0, index).trim()] = clip(line.slice(index + 1).trim(), 1000)
      }
    } catch {
      // ignore
    }
    return result
  }

  function installLifecycle() {
    const write = (phase) => {
      try {
        post('page.lifecycle', { phase, url: location.href, title: document.title })
      } catch {
        // ignore
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => write('DOMContentLoaded'), { once: true })
    } else {
      write('DOMContentLoaded')
    }
    if (document.readyState === 'complete') {
      write('load')
    } else {
      window.addEventListener('load', () => write('load'), { once: true })
    }
  }

  installConsole()
  installErrors()
  installFetch()
  installXhr()
  installLifecycle()
})()
