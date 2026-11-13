/**
 * Functions injected into tabs with chrome.scripting.executeScript.
 *
 * IMPORTANT: Chrome serializes these functions, so they must be fully
 * self-contained. They cannot reference imports, module globals, or helpers
 * defined outside their own body.
 */

/**
 * One entry point for DOM actions in the extension's ISOLATED world.
 * The isolated world is shared by all executions in a frame, so refs stored on
 * window.__DSH_PAGE__ survive between snapshot/click/type calls.
 *
 * @param {Record<string, any>} payload
 */
export function pageAction(payload) {
  const P = payload || {}
  const action = String(P.action || '')
  const state = window.__DSH_PAGE__ || (window.__DSH_PAGE__ = { refs: new Map(), nextRef: 0 })
  if (!(state.refs instanceof Map)) state.refs = new Map()
  if (!Number.isFinite(state.nextRef)) state.nextRef = 0

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
  ].join(',')

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
  const clip = (value, max) => {
    const text = String(value ?? '')
    return text.length > max ? `${text.slice(0, max)}…` : text
  }
  const textOf = (el) => {
    try {
      return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    } catch {
      return ''
    }
  }
  const visible = (el) => {
    if (!el || !el.isConnected || el.nodeType !== 1) return false
    try {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
      if (Number(style.opacity) === 0) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1
    } catch {
      return false
    }
  }
  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName
    if (tag === 'A') return 'link'
    if (tag === 'BUTTON') return 'button'
    if (tag === 'SELECT') return 'combobox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'SUMMARY') return 'button'
    if (el.isContentEditable) return 'textbox'
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file' || type === 'image') return 'button'
      return 'textbox'
    }
    return tag.toLowerCase()
  }
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return clip(aria, 200)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim()
      if (text) return clip(text, 200)
    }
    try {
      const labels = el.labels
      if (labels && labels.length > 0) {
        const text = String(labels[0].innerText || labels[0].textContent || '').trim()
        if (text) return clip(text, 200)
      }
    } catch {
      // ignore
    }
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return clip(placeholder, 200)
    const alt = el.getAttribute('alt')
    if (alt) return clip(alt, 200)
    const title = el.getAttribute('title')
    if (title) return clip(title, 200)
    const tag = el.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || el.getAttribute('role')) {
      const text = textOf(el)
      if (text) return clip(text, 200)
    }
    if (tag === 'INPUT' && (el.type === 'submit' || el.type === 'button')) return clip(el.value, 200)
    const name = el.getAttribute('name')
    return name ? clip(name, 200) : ''
  }
  const selectorOf = (el) => {
    try {
      if (el.id) return `#${CSS.escape(el.id)}`
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`
      const name = el.getAttribute('name')
      if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
      const aria = el.getAttribute('aria-label')
      if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`
      const parts = []
      let node = el
      let depth = 0
      while (node && node.nodeType === 1 && node !== document.body && depth < 4) {
        let part = node.tagName.toLowerCase()
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`)
          break
        }
        const parent = node.parentElement
        if (parent) {
          const siblings = [...parent.children].filter((child) => child.tagName === node.tagName)
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
        }
        parts.unshift(part)
        node = node.parentElement
        depth += 1
      }
      return parts.join(' > ')
    } catch {
      return ''
    }
  }
  const assignRef = (el) => {
    for (const [ref, node] of state.refs) {
      if (node === el && el.isConnected) return ref
    }
    const ref = `e${++state.nextRef}`
    state.refs.set(ref, el)
    return ref
  }
  const describe = (el) => {
    if (!el) return null
    const value = valueOf(el)
    return {
      tag: el.tagName?.toLowerCase() || '',
      role: roleOf(el),
      name: nameOf(el),
      ref: assignRef(el),
      selector: selectorOf(el),
      ...(value != null ? { value } : {}),
      ...(el.disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
    }
  }
  const valueOf = (el) => {
    const tag = el.tagName
    if (tag === 'INPUT') {
      if (el.type === 'password') return el.value ? '***' : ''
      if (el.type === 'file') return [...(el.files || [])].map((file) => file.name).join(', ')
      return clip(el.value, 300)
    }
    if (tag === 'TEXTAREA') return clip(el.value, 300)
    if (tag === 'SELECT') {
      const option = el.options?.[el.selectedIndex]
      return option ? clip(option.textContent || option.value, 300) : ''
    }
    if (el.isContentEditable) return clip(textOf(el), 300)
    return undefined
  }
  const resolve = (target) => {
    const T = target || {}
    if (T.ref) {
      const el = state.refs.get(String(T.ref))
      if (!el || !el.isConnected) {
        state.refs.delete(String(T.ref))
        throw new Error(`STALE_REF: ref "${T.ref}" is no longer valid; call browser_snapshot again`)
      }
      return el
    }
    if (T.selector) {
      let el
      try {
        el = document.querySelector(String(T.selector))
      } catch (error) {
        throw new Error(`BAD_SELECTOR: ${error.message}`)
      }
      if (!el) throw new Error(`NOT_FOUND: selector "${T.selector}" matched nothing`)
      return el
    }
    if (T.text) {
      const el = findTextElement(String(T.text))
      if (!el) throw new Error(`NOT_FOUND: no visible element contains "${T.text}"`)
      return el
    }
    if (Number.isFinite(Number(T.x)) && Number.isFinite(Number(T.y))) {
      const el = document.elementFromPoint(Number(T.x), Number(T.y))
      if (!el) throw new Error(`NOT_FOUND: no element at (${T.x}, ${T.y})`)
      return el
    }
    return null
  }
  const findTextElement = (needle) => {
    const wanted = String(needle || '').trim()
    if (!wanted) return null
    const candidates = [...document.querySelectorAll(INTERACTIVE)].filter(visible)
    for (const el of candidates) {
      const text = textOf(el)
      if (text === wanted) return el
    }
    for (const el of candidates) {
      const text = textOf(el)
      if (text.includes(wanted)) return el
    }
    let best = null
    let bestLength = Infinity
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
    let node
    let seen = 0
    while ((node = walker.nextNode()) && seen < 5000) {
      seen += 1
      const value = String(node.nodeValue || '')
      if (!value.includes(wanted)) continue
      const parent = node.parentElement
      if (!parent || !visible(parent)) continue
      const text = textOf(parent)
      if (text.length < bestLength) {
        best = parent
        bestLength = text.length
      }
    }
    return best
  }
  const setNativeValue = (el, value) => {
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (descriptor?.set) descriptor.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: value }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const snapshot = (params) => {
    state.refs.clear()
    state.nextRef = 0
    const roots = params.selector ? document.querySelectorAll(params.selector) : [document.body]
    if (!roots || roots.length === 0) throw new Error(`NOT_FOUND: selector "${params.selector}" matched nothing`)
    const root = roots[0]
    const matches = [...root.querySelectorAll(INTERACTIVE)].filter((el) => visible(el))
    const interactive = []
    for (const el of matches) {
      if (interactive.length >= 300) break
      if (el.tagName === 'A' && !el.getAttribute('href')) continue
      const item = describe(el)
      if (!item) continue
      const href = el.getAttribute('href')
      if (href) item.href = clip(href, 300)
      if (el.checked) item.checked = true
      const type = el.getAttribute('type')
      if (type) item.type = type
      interactive.push(item)
    }
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    }
    const maxY = Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      window.innerHeight,
    ) - window.innerHeight
    const includeText = params.includeText !== false
    let text = ''
    let textTruncated = false
    if (includeText) {
      const full = String(root.innerText || root.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
      const limit = Math.max(1000, Math.min(20000, Number(params.maxChars) || 30000))
      text = full.slice(0, limit)
      textTruncated = full.length > limit
    }
    return {
      url: location.href,
      title: document.title,
      viewport,
      scroll: { x: window.scrollX, y: window.scrollY, maxY: Math.max(0, maxY) },
      interactive,
      interactiveTotal: matches.length,
      text,
      truncated: textTruncated || matches.length > interactive.length,
    }
  }
  const read = (params) => {
    let root
    if (params.selector && params.selector !== 'body') {
      try {
        root = document.querySelector(params.selector)
      } catch (error) {
        throw new Error(`BAD_SELECTOR: ${error.message}`)
      }
      if (!root) throw new Error(`NOT_FOUND: selector "${params.selector}" matched nothing`)
    } else {
      root = document.body || document.documentElement
    }
    const full = String(root.innerText || root.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
    const limit = Math.max(100, Number(params.maxChars) || 30000)
    return {
      url: location.href,
      title: document.title,
      text: full.slice(0, limit),
      truncated: full.length > limit,
    }
  }
  const click = async (params) => {
    const el = resolve(params)
    if (!el) throw new Error('NOT_FOUND: no click target')
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch {
      el.scrollIntoView()
    }
    await sleep(30)
    const rect = el.getBoundingClientRect()
    const clientX = Number.isFinite(Number(params.x)) ? Number(params.x) : rect.left + rect.width / 2
    const clientY = Number.isFinite(Number(params.y)) ? Number(params.y) : rect.top + rect.height / 2
    const button = String(params.button || 'left')
    const clickCount = Math.max(1, Math.min(3, Number(params.clickCount) || 1))
    const mouse = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: button === 'right' ? 2 : button === 'middle' ? 1 : 0 }
    if (button === 'left') {
      el.click()
      if (clickCount > 1) el.dispatchEvent(new MouseEvent('dblclick', mouse))
    } else if (button === 'right') {
      el.dispatchEvent(new MouseEvent('pointerdown', mouse))
      el.dispatchEvent(new MouseEvent('mousedown', mouse))
      el.dispatchEvent(new MouseEvent('mouseup', mouse))
      el.dispatchEvent(new MouseEvent('contextmenu', mouse))
    } else {
      el.dispatchEvent(new MouseEvent('pointerdown', mouse))
      el.dispatchEvent(new MouseEvent('mousedown', mouse))
      el.dispatchEvent(new MouseEvent('mouseup', mouse))
    }
    await sleep(Number(params.waitMs) || 0)
    return { clicked: true, ...describe(el), url: location.href }
  }
  const type = async (params) => {
    const el = resolve(params)
    if (!el) throw new Error('NOT_FOUND: no input target')
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable)) {
      throw new Error(`NOT_EDITABLE: <${el.tagName.toLowerCase()}> is not an input, textarea, select or contenteditable`)
    }
    el.focus()
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
    } catch {
      // ignore
    }
    const value = String(params.value ?? '')
    const delay = Math.max(0, Number(params.delayMs) || 0)
    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find((item) => item.value === value || String(item.textContent || '').trim() === value)
      if (!option) throw new Error(`OPTION_NOT_FOUND: select has no option matching "${clip(value, 80)}"`)
      el.value = option.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (el.isContentEditable && !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      el.focus()
      if (params.clear !== false) {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        const range = document.createRange()
        range.selectNodeContents(el)
        selection?.addRange(range)
        document.execCommand('delete')
      }
      if (!document.execCommand('insertText', false, value)) {
        el.textContent = `${params.clear !== false ? '' : el.textContent || ''}${value}`
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    } else {
      if (delay > 0) {
        let current = params.clear !== false ? '' : el.value
        for (const character of value) {
          current += character
          setNativeValue(el, current)
          await sleep(delay)
        }
      } else {
        setNativeValue(el, value)
      }
    }
    let submitted = false
    if (params.submit) {
      const keydown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
      const notPrevented = el.dispatchEvent(keydown)
      el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      if (notPrevented && el.form && typeof el.form.requestSubmit === 'function') {
        try {
          el.form.requestSubmit()
          submitted = true
        } catch {
          submitted = false
        }
      } else {
        submitted = notPrevented
      }
    }
    return { typed: true, ...describe(el), submitted }
  }
  const keyCodeFor = (key) => {
    const map = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 }
    if (map[key]) return map[key]
    if (key.length === 1) return key.toUpperCase().charCodeAt(0)
    return 0
  }
  const codeFor = (key) => {
    if (key.length === 1 && /[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`
    if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`
    if (key === ' ') return 'Space'
    return key
  }
  const press = (params) => {
    const combo = String(params.key || '')
    if (!combo) throw new Error('BAD_KEY: empty key')
    const parts = combo === '+' ? ['+'] : combo.split('+')
    const key = parts.pop()
    const modifiers = parts.map((part) => part.toLowerCase())
    const target = (params.ref || params.selector) ? resolve(params) : document.activeElement
    if (target && target.focus) target.focus()
    const init = {
      key,
      code: codeFor(key),
      keyCode: keyCodeFor(key),
      which: keyCodeFor(key),
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes('control') || modifiers.includes('ctrl'),
      metaKey: modifiers.includes('meta') || modifiers.includes('cmd') || modifiers.includes('command'),
      altKey: modifiers.includes('alt') || modifiers.includes('option'),
      shiftKey: modifiers.includes('shift'),
    }
    target?.dispatchEvent(new KeyboardEvent('keydown', init))
    target?.dispatchEvent(new KeyboardEvent('keypress', init))
    target?.dispatchEvent(new KeyboardEvent('keyup', init))
    return { pressed: true, target: target ? `${target.tagName?.toLowerCase() || ''}${nameOf(target) ? ` "${nameOf(target)}"` : ''}` : '' }
  }
  const scroll = async (params) => {
    const direction = String(params.direction || 'down')
    const target = (params.ref || params.selector) ? resolve(params) : null
    const isWindow = !target || target === document.body || target === document.documentElement
    const amount = Number(params.amount) > 0
      ? Number(params.amount)
      : isWindow
        ? (direction === 'left' || direction === 'right' ? window.innerWidth : window.innerHeight) * 0.85
        : (direction === 'left' || direction === 'right' ? target.clientWidth : target.clientHeight) * 0.85
    const scrollBy = (dx, dy) => {
      if (isWindow) window.scrollBy(dx, dy)
      else target.scrollBy(dx, dy)
    }
    const scrollTo = (x, y) => {
      if (isWindow) window.scrollTo(x, y)
      else target.scrollTo(x, y)
    }
    if (direction === 'up') scrollBy(0, -amount)
    else if (direction === 'down') scrollBy(0, amount)
    else if (direction === 'left') scrollBy(-amount, 0)
    else if (direction === 'right') scrollBy(amount, 0)
    else if (direction === 'top') {
      if (isWindow) window.scrollTo(window.scrollX, 0)
      else target.scrollTo(target.scrollLeft, 0)
    } else if (direction === 'bottom') {
      if (isWindow) window.scrollTo(window.scrollX, Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0))
      else target.scrollTo(target.scrollLeft, target.scrollHeight)
    } else {
      throw new Error(`BAD_DIRECTION: ${direction}`)
    }
    await sleep(120)
    return {
      scrollX: isWindow ? window.scrollX : target.scrollLeft,
      scrollY: isWindow ? window.scrollY : target.scrollTop,
      scrollHeight: isWindow ? Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0) : target.scrollHeight,
    }
  }
  const wait = async (params) => {
    const wanted = String(params.value || '')
    const timeoutMs = Math.max(100, Math.min(120000, Number(params.timeoutMs) || 10000))
    const pollMs = Math.max(50, Math.min(2000, Number(params.pollMs) || 200))
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (params.for === 'selector') {
        let el
        try {
          el = document.querySelector(wanted)
        } catch (error) {
          throw new Error(`BAD_SELECTOR: ${error.message}`)
        }
        if (el && visible(el)) return { matched: true, ref: assignRef(el), elapsedMs: Date.now() - started }
      } else if (params.for === 'text') {
        const el = findTextElement(wanted)
        if (el) return { matched: true, ref: assignRef(el), elapsedMs: Date.now() - started }
      } else {
        throw new Error(`BAD_WAIT: ${params.for}`)
      }
      await sleep(pollMs)
    }
    throw new Error(`WAIT_TIMEOUT: ${params.for} "${wanted}" not found within ${timeoutMs}ms`)
  }

  switch (action) {
    case 'snapshot':
      return snapshot(P)
    case 'read':
      return read(P)
    case 'click':
      return click(P)
    case 'type':
      return type(P)
    case 'press':
      return press(P)
    case 'scroll':
      return scroll(P)
    case 'wait':
      return wait(P)
    default:
      throw new Error(`UNSUPPORTED_ACTION: ${action}`)
  }
}

/**
 * Evaluate user code in the page MAIN world.
 * Returns a JSON-safe value or { __dshError: { code, message, stack } }.
 */
export async function pageEval(expression, awaitPromise) {
  const clip = (value, max) => {
    const text = String(value ?? '')
    return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
  }
  const serialize = (value, depth = 0, seen = new WeakSet()) => {
    if (value === undefined) return '[undefined]'
    if (value === null) return null
    const type = typeof value
    if (type === 'string') return clip(value, 100000)
    if (type === 'number' || type === 'boolean') return value
    if (type === 'bigint') return `${value}n`
    if (type === 'symbol') return value.toString()
    if (type === 'function') return `[Function ${value.name || 'anonymous'}]`
    if (depth > 4) return '[depth limit]'
    if (seen.has(value)) return '[Circular]'
    try {
      if (value instanceof Error) return { name: value.name, message: clip(value.message, 4000), stack: clip(value.stack, 8000) }
      if (typeof Node !== 'undefined' && value instanceof Node) return `<${String(value.nodeName).toLowerCase()}${value.id ? `#${value.id}` : ''}>`
      if (value instanceof Date) return value.toISOString()
      if (value instanceof RegExp) return String(value)
      if (typeof Map !== 'undefined' && value instanceof Map) {
        seen.add(value)
        return [...value.entries()].slice(0, 50).map(([key, item]) => [serialize(key, depth + 1, seen), serialize(item, depth + 1, seen)])
      }
      if (typeof Set !== 'undefined' && value instanceof Set) {
        seen.add(value)
        return [...value.values()].slice(0, 50).map((item) => serialize(item, depth + 1, seen))
      }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return `[${value.constructor?.name || 'Binary'} ${value.byteLength} bytes]`
      if (Array.isArray(value)) {
        seen.add(value)
        return value.slice(0, 100).map((item) => serialize(item, depth + 1, seen))
      }
      seen.add(value)
      const result = {}
      for (const key of Object.keys(value).slice(0, 60)) {
        try {
          result[key] = serialize(value[key], depth + 1, seen)
        } catch (error) {
          result[key] = `[getter threw: ${error instanceof Error ? error.message : String(error)}]`
        }
      }
      return result
    } catch (error) {
      return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`
    }
  }
  const detectCsp = (error) => {
    const message = String(error?.message || error || '')
    return /unsafe-eval|content security policy|EvalError|Refused to evaluate/i.test(message)
  }
  try {
    if (typeof expression !== 'string' || expression.trim() === '') throw new Error('expression is empty')
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    let fn
    try {
      fn = new AsyncFunction(`"use strict"; return (${expression}\n);`)
    } catch {
      fn = new AsyncFunction(`"use strict";\n${expression}`)
    }
    let value = fn.call(window)
    if (awaitPromise !== false && value && typeof value.then === 'function') {
      value = await value
    }
    if (value && typeof value.then === 'function') {
      return { value: '[Promise]', type: 'promise' }
    }
    const serialized = serialize(value)
    let json
    try {
      json = JSON.stringify(serialized)
    } catch {
      json = ''
    }
    if (json && json.length > 200000) {
      return { value: `${json.slice(0, 200000)}… [truncated]`, type: typeof value, truncated: true }
    }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    return { value: serialized, type }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      __dshError: {
        code: detectCsp(error) ? 'CSP_BLOCKED' : 'EVAL_ERROR',
        message: clip(message, 4000),
        stack: clip(error instanceof Error ? error.stack : '', 4000),
      },
    }
  }
}
