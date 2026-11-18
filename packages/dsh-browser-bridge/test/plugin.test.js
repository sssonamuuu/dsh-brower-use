import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

test('plugin apply starts the bridge, registers tools, and disposes cleanly', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-plugin-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const definitions = new Map()
  const disposers = []
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section)
            return () => {}
          },
        }
      }
      return undefined
    },
    async effect(callback) {
      const dispose = await callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        callback({
          webServer: { register: () => () => {} },
          effect: (fn) => {
            const dispose = fn()
            if (typeof dispose === 'function') disposers.push(dispose)
            return dispose
          },
        })
      }
    },
  }

  await apply(ctx, { port: 0, portRange: 1, stateDir })
  const expected = [
    'browser_status',
    'browser_tabs',
    'browser_snapshot',
    'browser_read',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_eval',
    'browser_console',
    'browser_network',
    'browser_wait',
  ]
  assert.deepEqual([...definitions.keys()].sort(), expected.sort())
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:browser')

  const status = await definitions.get('browser_status').execute({}, { signal: new AbortController().signal })
  assert.match(status, /Bridge: listening on http:\/\/127\.0\.0\.1:\d+/)
  const port = /127\.0\.0\.1:(\d+)/.exec(status)[1]
  const hello = await fetch(`http://127.0.0.1:${port}/hello`)
  assert.equal(hello.status, 200)

  for (const dispose of disposers.reverse()) await dispose()
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/hello`))
})

test('activate route focuses a tab for same-origin callers only', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-activate-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const routes = new Map()
  const disposers = []
  const collect = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register() { return () => {} } },
    get() { return undefined },
    async effect(callback) { return collect(await callback()) },
    inject(deps, callback) {
      if (!deps.includes('webServer')) return
      callback({
        webServer: { register: (options) => { routes.set(options.path, options); return () => {} } },
        effect: (fn) => collect(fn()),
      })
    },
  }
  await apply(ctx, { port: 0, portRange: 1, stateDir })

  const route = routes.get('/api/browser-bridge/activate')
  assert.ok(route, 'the activate route is registered')
  assert.equal(typeof route.handler, 'function', 'a POST side effect owns the raw handler')

  /** Minimal node:http request stand-in: async-iterable body plus headers. */
  const request = (init = {}) => ({
    method: init.method ?? 'POST',
    headers: init.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (init.body) yield init.body
    },
  })
  const response = () => ({
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body ?? '' },
  })
  const call = async (init) => {
    const res = response()
    await route.handler(request(init), res)
    return res
  }

  // A foreign page must not be able to move the user's browser focus.
  let res = await call({ headers: { origin: 'https://evil.test', host: '127.0.0.1:1' }, body: '{"tabId":7}' })
  assert.equal(res.status, 403)

  // GET would let a link or prefetch trigger it.
  res = await call({ method: 'GET', headers: {} })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')

  res = await call({ headers: {}, body: '{}' })
  assert.equal(res.status, 400)
  assert.match(res.body, /tabId is required/)

  res = await call({ headers: {}, body: 'not json' })
  assert.equal(res.status, 400)

  // No extension connected: a clear 503 rather than a hang or a 500.
  res = await call({ headers: {}, body: '{"tabId":7}' })
  assert.equal(res.status, 503)
  assert.match(res.body, /NO_CLIENT/)

  // Releasing the plugin stops the bridge instead of leaving it listening.
  for (const dispose of disposers.reverse()) await dispose()
})
