import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeBridge, FakeExtension } from './helpers.js'
import { registerBrowserTools } from '../lib/tools.js'
import { PACKAGE_VERSION } from '../lib/protocol.js'

async function makeToolkit(t, fakeOptions) {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const fake = await new FakeExtension(bridge, fakeOptions).connect()
  t.after(() => fake.close())
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-cwd-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const definitions = new Map()
  const ctx = { tools: { register(definition) { definitions.set(definition.name, definition) } } }
  registerBrowserTools(ctx, { bridge, getCwd: async () => cwd, logger: null })
  return { bridge, fake, cwd, definitions }
}

function execute(definitions, name, args = {}) {
  const definition = definitions.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition.execute(args, { signal: new AbortController().signal, agent: null })
}

test('browser_status reports auto-pair and connection state', async (t) => {
  const { bridge, definitions } = await makeToolkit(t)
  const text = await execute(definitions, 'browser_status')
  // The reported version must follow the package version, so a release bump
  // cannot silently leave the status line stale.
  assert.match(text, new RegExp(`DSH Browser Bridge v${PACKAGE_VERSION.replaceAll('.', '\\.')}`))
  assert.match(text, /Auto-pair: enabled/)
  assert.match(text, /Extension: connected/)
  assert.match(text, /TestChrome 999\.0\.0\.0/)
})

test('browser_tabs list / activate / open format tab data', async (t) => {
  const { definitions } = await makeToolkit(t)
  const list = await execute(definitions, 'browser_tabs', { action: 'list' })
  assert.match(list, /id=1 win=1 "App"/)
  assert.match(list, /id=2 win=1 "Docs"/)
  assert.match(list, /ACTIVE/)

  const activated = await execute(definitions, 'browser_tabs', { action: 'activate', tabId: 2 })
  assert.match(activated, /Activated tab 2/)

  const opened = await execute(definitions, 'browser_tabs', { action: 'open', url: 'http://localhost:3000/new' })
  assert.match(opened, /Opened tab 3/)
})

test('browser_snapshot formats refs, values and text', async (t) => {
  const { definitions } = await makeToolkit(t)
  const text = await execute(definitions, 'browser_snapshot')
  assert.match(text, /Page: App — http:\/\/localhost:3000\//)
  assert.match(text, /\[e1\] · textbox · "Email" · type=text · value="a@b\.c"/)
  assert.match(text, /\[e2\] · button · "Save"/)
  assert.match(text, /Welcome to the app/)
})

test('browser_console reads buffered events and filters levels', async (t) => {
  const { bridge, fake, definitions } = await makeToolkit(t)
  fake.event(1, 'console', { level: 'error', text: 'boom', stack: 'at App.tsx:1:2', args: ['boom'] }, 1)
  fake.event(1, 'console', { level: 'log', text: 'hello', args: ['hello'] }, 2)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(bridge.state.consoleFor(1).entries.length, 2)

  const errors = await execute(definitions, 'browser_console', { level: 'error', limit: 10 })
  assert.match(errors, /ERROR boom/)
  assert.match(errors, /at App\.tsx:1:2/)
  assert.doesNotMatch(errors, /hello/)

  const all = await execute(definitions, 'browser_console', { level: 'all', limit: 10 })
  assert.match(all, /hello/)
  await execute(definitions, 'browser_console', { clear: true })
  assert.equal(bridge.state.consoleFor(1).entries.length, 0)
})

test('browser_network lists requests and returns details/body', async (t) => {
  const { fake, definitions } = await makeToolkit(t)
  fake.event(1, 'network.request', { id: 'r1', method: 'GET', url: 'http://localhost/api/users', type: 'fetch', requestHeaders: { accept: 'application/json' } })
  fake.event(1, 'network.response', { id: 'r1', status: 500, statusText: 'Server Error', responseHeaders: { 'content-type': 'application/json' }, mimeType: 'application/json', durationMs: 18 })
  fake.event(1, 'network.body', { id: 'r1', body: '{"error":"bad"}', size: 15 })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const list = await execute(definitions, 'browser_network', { action: 'list' })
  assert.match(list, /\[r1\] GET http:\/\/localhost\/api\/users → 500/)
  assert.match(list, /→ 500 · 18ms · 15 B · fetch/)

  const detail = await execute(definitions, 'browser_network', { action: 'get', requestId: 'r1' })
  assert.match(detail, /Status: 500 Server Error/)
  assert.match(detail, /accept: application\/json/)
  assert.match(detail, /\{"error":"bad"\}/)

  const filtered = await execute(definitions, 'browser_network', { action: 'list', status: '5xx' })
  assert.match(filtered, /r1/)
  const empty = await execute(definitions, 'browser_network', { action: 'list', status: '2xx' })
  assert.match(empty, /0 shown/)
})

test('browser_screenshot writes a PNG and returns a readable path', async (t) => {
  const { cwd, definitions } = await makeToolkit(t)
  const text = await execute(definitions, 'browser_screenshot')
  const match = /Screenshot saved: (.+\.png)/.exec(text)
  assert.ok(match, text)
  const file = match[1]
  assert.ok(file.startsWith(cwd))
  const buffer = await readFile(file)
  assert.equal(buffer[0], 0x89)
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG')
  assert.match(text, /1x1/)
  assert.match(text, /read_image/)
})

test('browser_eval returns evaluated values', async (t) => {
  const { definitions } = await makeToolkit(t)
  const text = await execute(definitions, 'browser_eval', { expression: 'document.title' })
  assert.match(text, /Result \(string\):/)
  assert.match(text, /App/)
})

test('browser_wait delegates selector waits', async (t) => {
  const { definitions } = await makeToolkit(t)
  const text = await execute(definitions, 'browser_wait', { for: 'selector', value: '.loaded' })
  assert.match(text, /Matched selector ".loaded"/)
})

test('tools explain how to pair when no extension is connected', async (t) => {
  const { bridge, fake, definitions } = await makeToolkit(t)
  fake.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await assert.rejects(
    () => execute(definitions, 'browser_tabs', { action: 'list' }),
    (error) => {
      assert.match(error.message, /extension is not connected/i)
      assert.match(error.message, new RegExp(bridge.pairingCode))
      return true
    },
  )
})

test('browser_type requires a value at the schema boundary', async (t) => {
  const { definitions } = await makeToolkit(t)
  await assert.rejects(
    () => execute(definitions, 'browser_type', { ref: 'e1' }),
    (error) => {
      assert.match(error.message, /value/)
      return true
    },
  )
})

test('browser_click rejects ambiguous targets', async (t) => {
  const { definitions } = await makeToolkit(t)
  await assert.rejects(
    () => execute(definitions, 'browser_click', { ref: 'e1', selector: '#save' }),
    /exactly one target/,
  )
})
