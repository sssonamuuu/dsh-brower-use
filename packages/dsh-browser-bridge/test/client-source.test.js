import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/**
 * Import the shipped client bundle once and return its registered entry.
 *
 * The bundle registers itself with `window.__ModuleLoader__` as an import side
 * effect, so ESM runs it a single time; later callers reuse the first capture.
 */
let entryPromise
function getEntry() {
  entryPromise ??= (async () => {
    const captured = {}
    const previous = globalThis.window
    globalThis.window = { __ModuleLoader__: { load(entry) { captured.entry = entry } } }
    try {
      await import(pathToFileURL(path.join(root, 'packages/dsh-browser-bridge/lib/client.js')).href)
    } finally {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    }
    assert.ok(captured.entry, 'client bundle must register itself with __ModuleLoader__')
    return captured.entry
  })()
  return entryPromise
}

/**
 * A rendererless React stand-in. Components are called directly instead of
 * mounted, so `useState` records the last update rather than re-rendering.
 */
function createReactStub(state) {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, (next) => { state.lastSet = typeof next === 'function' ? next(state.lastSet) : next }],
  }
}

/** Materialize the bundle and apply it, returning what the Web GUI would receive. */
async function loadClientPlugin() {
  const entry = await getEntry()
  const state = { lastSet: undefined }
  const React = createReactStub(state)
  const exported = entry.factory(() => React)
  const rules = []
  const components = new Map()
  let source
  const services = {
    uiConversation: { userText: { register(rule) { rules.push(rule); return () => {} } } },
    slots: {
      inject(_owner, callback) { callback(); return () => {} },
      register(options, component) { components.set(options.key, component); return () => {} },
    },
  }
  exported.apply({
    get: (name) => (name === 'inputTriggers'
      ? { registerSource(value) { source = value; return () => {} } }
      : undefined),
    inject(_names, callback) { callback({ ...services, effect: (fn) => fn() }) },
    effect: (callback) => callback(),
  })
  return { rules, components, source, state }
}

test('client @ source maps open tabs to candidates and serializable references', async (t) => {
  const entry = await getEntry()
  assert.equal(entry.id, '@sssonamuuu/dsh-browser-bridge')
  const state = { lastSet: undefined }
  const React = createReactStub(state)
  const exports = entry.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['inputTriggers'])

  const originalFetch = globalThis.fetch
  const armed = []
  const activated = []
  let activateResponse = { ok: true, status: 200 }
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/browser-bridge/activate') {
      activated.push(JSON.parse(options.body))
      return {
        ok: activateResponse.ok,
        status: activateResponse.status,
        async json() { return activateResponse.ok ? { ok: true } : { ok: false, error: 'NO_CLIENT' } },
      }
    }
    if (url === '/api/browser-bridge/arm') {
      armed.push(JSON.parse(options.body))
      return { ok: true, async json() { return { ok: true, armed: true } } }
    }
    assert.equal(url, '/api/browser-bridge/tabs')
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          browser: { brand: 'Edge', engine: 'chromium', version: '157.0.0.0' },
          tabs: [
            { id: 7, windowId: 1, title: 'Local app', url: 'http://localhost:3000/', favIconUrl: 'http://localhost:3000/favicon.ico', active: true, browser: 'Edge' },
            { id: 8, windowId: 1, title: 'Docs', url: 'http://localhost:3000/docs', favIconUrl: '', active: false, discarded: true, browser: 'Chrome' },
            { id: 9, windowId: 1, title: 'Arc page', url: 'http://localhost:3000/arc', favIconUrl: '', active: false, browser: 'Arc' },
            { id: 10, windowId: 1, title: 'Another Edge', url: 'http://localhost:3000/edge2', favIconUrl: '', active: false, browser: 'Edge' },
          ],
        }
      },
    }
  }
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.window })

  let source
  let chipRule
  let legacyRule
  let chipComponent
  const chipKeys = []
  const services = {
    uiConversation: { userText: { register(rule) {
      if (rule.id === 'browser-tab') chipRule = rule
      else legacyRule = rule
      return () => {}
    } } },
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'conversation.user.text.node')
        callback()
        return () => {}
      },
      register(options, component) {
        chipKeys.push(options.key)
        chipComponent = component
        return () => {}
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'inputTriggers') {
        return { registerSource(value) { source = value; return () => {} } }
      }
      return services[name]
    },
    // Cordis: run the callback once every named service is available.
    inject(names, callback) {
      for (const name of names) assert.ok(services[name], `unknown service ${name}`)
      const scope = {
        ...ctx,
        get: (name) => services[name],
        effect: (fn) => fn(),
        ...services,
      }
      callback(scope)
    },
    effect(callback) { return callback() },
  }
  exports.apply(ctx)
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'browser-tab')

  const rows = await source.candidates({}, { query: '', signal: new AbortController().signal })
  assert.equal(rows.length, 4)
  assert.equal(rows[0].name, 'Local app')
  assert.match(textOf(rows[0].section), /Edge 浏览器标签/)
  assert.equal(rows[1].name, 'Another Edge')
  assert.equal(rows[1].section, rows[0].section, 'same-browser rows share one section object')
  assert.match(textOf(rows[2].section), /Chrome 浏览器标签/)
  const edgeLogo = rows[0].section.children.find((child) => child?.type === 'img')
  assert.match(edgeLogo.props.src, /^data:image\/svg\+xml/)
  assert.match(textOf(rows[3].section), /^A浏览器标签$/)
  assert.match(rows[0].description, /localhost:3000/)
  assert.match(rows[0].description, /当前/)
  assert.match(rows[2].description, /已休眠/)
  assert.equal(typeof rows[0].icon, 'function')
  const icon = rows[0].icon({ size: 14 })
  assert.equal(icon.type, 'span')
  const faviconImage = icon.children.find((child) => child?.type === 'img')
  assert.equal(faviconImage.props.src, 'http://localhost:3000/favicon.ico')

  const filtered = await source.candidates({}, { query: 'docs', signal: new AbortController().signal })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].name, 'Docs')

  const picked = source.onPick({ candidate: rows[0] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(armed, [{ tabId: 7 }])
  assert.equal(picked.insert.source, 'browser-tab')
  assert.equal(picked.insert.label, 'Local app')
  assert.match(picked.insert.clipboardText, /dsh-browser-tab:7/)
  const serialized = await source.codec.serialize(picked.insert.ref)
  // The URL stays in the model-facing text, percent-encoded inside the target.
  assert.equal(serialized, '@[Local app](dsh-browser-tab:7?url=http%3A%2F%2Flocalhost%3A3000%2F)')
  assert.equal(source.openReference(), false)

  // The chip half: a text rule that finds the wire form and a keyed renderer.
  assert.deepEqual(chipKeys, ['browser-tab', 'browser-tab-legacy'])
  assert.equal(chipRule.id, 'browser-tab')
  const wire = `open ${serialized} please`
  const node = chipRule.match(wire, 0)
  assert.equal(node.id, 'browser-tab')
  assert.equal(node.data.tabId, 7)
  assert.equal(node.data.label, 'Local app')
  assert.equal(node.data.url, 'http://localhost:3000/')
  assert.equal(wire.slice(node.start, node.end), serialized)
  assert.equal(chipRule.match('no reference here', 0), undefined)
  // A URL with its own parentheses must not truncate the reference.
  const paren = source.onPick({
    candidate: { value: JSON.stringify({ id: 12, title: 'Wiki', url: 'https://x.test/a_(b)' }) },
  })
  const parenWire = await source.codec.serialize(paren.insert.ref)
  assert.equal(parenWire, '@[Wiki](dsh-browser-tab:12?url=https%3A%2F%2Fx.test%2Fa_%28b%29)')
  assert.equal(chipRule.match(parenWire, 0).end, parenWire.length)
  // A label containing brackets or newlines must not forge a second reference.
  const awkward = source.onPick({
    candidate: { value: JSON.stringify({ id: 11, title: 'a]b[c\nd', url: 'http://localhost:3000/x' }) },
  })
  const awkwardWire = await source.codec.serialize(awkward.insert.ref)
  assert.match(awkwardWire, /^@\[a b c d\]\(dsh-browser-tab:11\?url=/)
  const awkwardNode = chipRule.match(awkwardWire, 0)
  assert.equal(awkwardNode.end, awkwardWire.length)

  const chip = chipComponent({ node, raw: serialized })
  assert.equal(chip.type, 'span')
  assert.equal(chip.props.className, 'dbb-ref dbb-ref-clickable', 'styling comes from the plugin stylesheet, not inline styles')
  assert.equal(chip.props.style, undefined)
  assert.equal(textOf(chip).includes('Local app'), true)
  assert.equal(chip.props.title, 'Local app\nhttp://localhost:3000/')
  // Clickable references are buttons to assistive tech and reachable by Tab.
  assert.equal(chip.props.role, 'button')
  assert.equal(chip.props.tabIndex, 0)

  // Clicking asks the Host to focus the referenced tab.
  await chip.props.onClick({})
  assert.deepEqual(activated, [{ tabId: 7 }])
  assert.equal(state.lastSet, false, 'a successful activation leaves no error state')

  // A disconnected extension surfaces as the failed rendering instead of silence.
  activateResponse = { ok: false, status: 503 }
  await chip.props.onClick({})
  assert.equal(state.lastSet, true)

  // Selecting text across the chip must not steal the click.
  const selection = { toString: () => 'selected words' }
  globalThis.getSelection = () => selection
  t.after(() => { delete globalThis.getSelection })
  const before = activated.length
  await chip.props.onClick({})
  assert.equal(activated.length, before, 'a non-empty selection suppresses activation')

  // Enter and Space activate as well; other keys are ignored.
  delete globalThis.getSelection
  await chip.props.onKeyDown({ key: 'Enter' })
  assert.equal(activated.length, before + 1)
  await chip.props.onKeyDown({ key: 'a' })
  assert.equal(activated.length, before + 1)

  // Messages sent before 0.1.3 still render as chips instead of raw brackets.
  assert.equal(legacyRule.id, 'browser-tab-legacy')
  const old = '[Browser tab id=9] Docs — http://localhost:3000/docs'
  const oldNode = legacyRule.match(`see ${old} now`, 0)
  assert.equal(oldNode.data.tabId, 9)
  assert.equal(oldNode.data.label, 'Docs')
  assert.equal(oldNode.data.url, 'http://localhost:3000/docs')
  assert.equal(`see ${old} now`.slice(oldNode.start, oldNode.end), old)
})

test('whatever serialize emits, the rule matches whole', async () => {
  // Titles come from arbitrary page metadata, so the serializer/rule pair must
  // hold for hostile labels: brackets, newlines, CJK, and length overflow.
  const { rules, source } = await loadClientPlugin()
  const wire = rules.find((rule) => rule.id === 'browser-tab')
  const titles = ['A [x] B', 'a]b', '[start', 'end]', 'normal', '中文】括号', 'a\tb', 'x'.repeat(200), '']
  for (const title of titles) {
    const ref = JSON.stringify({ id: 42, title, url: 'https://e.test/p?q=%28a%29' })
    const text = await source.codec.serialize(ref)
    const node = wire.match(text, 0)
    assert.ok(node, `rule must match ${JSON.stringify(text)}`)
    assert.equal(node.start, 0)
    assert.equal(node.end, text.length, `rule must consume all of ${JSON.stringify(text)}`)
    assert.equal(node.data.tabId, 42)
    assert.equal(node.data.url, 'https://e.test/p?q=%28a%29', 'percent-encoded URL decodes back')
  }
})

test('a sent message parses into chips with no gaps and no false positives', async () => {
  // Reconcile like the harness does: earliest start wins, ties break on order.
  const evaluate = (rules, text) => {
    const ordered = [...rules].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    const nodes = []
    let cursor = 0
    while (cursor < text.length) {
      let winner
      for (const rule of ordered) {
        const found = rule.match(text, cursor)
        if (found && (winner === undefined || found.start < winner.start)) winner = found
      }
      if (winner === undefined) {
        nodes.push({ id: 'text', start: cursor, end: text.length })
        break
      }
      if (cursor < winner.start) nodes.push({ id: 'text', start: cursor, end: winner.start })
      nodes.push(winner)
      cursor = winner.end
    }
    return nodes
  }

  const { rules, components } = await loadClientPlugin()
  const message = '看一下 @[devops 环境](dsh-browser-tab:2142824295?url=https%3A%2F%2Fdevops.yzw.cn%2Fx%3Fa%3D1) 这个页面的报错'
  const nodes = evaluate(rules, message)
  assert.deepEqual(nodes.map((n) => n.id), ['text', 'browser-tab', 'text'])
  // Every character belongs to exactly one node, and they stay in order.
  let cursor = 0
  for (const node of nodes) {
    assert.equal(node.start, cursor)
    cursor = node.end
  }
  assert.equal(cursor, message.length)

  const chip = components.get('browser-tab')({ node: nodes[1], raw: message.slice(nodes[1].start, nodes[1].end) })
  assert.match(textOf(chip), /devops 环境/)
  assert.match(chip.props.title, /devops\.yzw\.cn/)

  // Prose that only mentions the scheme stays plain text.
  assert.deepEqual(evaluate(rules, 'the dsh-browser-tab:5 scheme').map((n) => n.id), ['text'])
  // A legacy message keeps the sentence after the reference.
  const legacy = evaluate(rules, '看 [Browser tab id=9] Docs — http://localhost:3000/docs 的报错')
  assert.deepEqual(legacy.map((n) => n.id), ['text', 'browser-tab-legacy', 'text'])
  assert.equal('看 [Browser tab id=9] Docs — http://localhost:3000/docs 的报错'.slice(legacy[2].start), ' 的报错')
})
