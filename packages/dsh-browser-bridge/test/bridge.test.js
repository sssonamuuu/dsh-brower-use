import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, chmod } from 'node:fs/promises'
import { makeBridge, FakeExtension } from './helpers.js'

test('/hello identifies the bridge and reports pairing availability', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const response = await fetch(`${bridge.url}/hello`)
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.app, 'dsh-browser-bridge')
  assert.equal(data.protocol, 1)
  assert.equal(data.port, bridge.port)
  assert.equal(data.pairing, true)
})

test('pairing code exchanges for a token and sets CORS only for extension origins', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)

  const bad = await fetch(`${bridge.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ code: '000000' }),
  })
  assert.equal(bad.status, 401)
  assert.equal(bad.headers.get('access-control-allow-origin'), null)

  const good = await fetch(`${bridge.url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' },
    body: JSON.stringify({ code: bridge.pairingCode }),
  })
  assert.equal(good.status, 200)
  assert.equal(good.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop')
  const data = await good.json()
  assert.equal(data.ok, true)
  assert.match(data.token, /^[a-f0-9]{64}$/)
  assert.equal(data.port, bridge.port)
})

test('pairing failures are rate limited', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  let last
  for (let index = 0; index < 6; index++) {
    last = await fetch(`${bridge.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '999999' }),
    })
  }
  assert.equal(last.status, 429)
  const data = await last.json()
  assert.equal(data.error, 'rate_limited')
})

test('token persists across restarts while pairing code rotates', async (t) => {
  const first = await makeBridge({ keepState: true })
  const { bridge, stateDir } = first
  const token = bridge.token
  const code = bridge.pairingCode
  await bridge.stop()
  const { BridgeServer } = await import('../lib/bridge-server.js')
  const second = new BridgeServer({ port: 0, portRange: 1, stateDir })
  await second.start()
  t.after(async () => {
    await second.stop()
    const { rm } = await import('node:fs/promises')
    await rm(stateDir, { recursive: true, force: true })
  })
  assert.equal(second.token, token)
  assert.notEqual(second.pairingCode, code)
  const mode = (await import('node:fs')).statSync(second.stateFile).mode & 0o777
  assert.equal(mode, 0o600)
})

test('command round-trip resolves with extension data', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const fake = await new FakeExtension(bridge, {
    onCommand: async (action) => {
      if (action === 'tabs.list') return { tabs: [{ id: 7, title: 'Seven', url: 'http://x/' }] }
      throw Object.assign(new Error('nope'), { code: 'UNSUPPORTED_ACTION' })
    },
  }).connect()
  t.after(() => fake.close())

  const tabs = await bridge.command('tabs.list')
  assert.equal(tabs.tabs[0].id, 7)

  await assert.rejects(
    () => bridge.command('page.explode'),
    (error) => error.code === 'UNSUPPORTED_ACTION' && /nope/.test(error.message),
  )
})

test('command timeout and disconnect reject pending commands', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const fake = await new FakeExtension(bridge, {
    onCommand: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return {}
    },
  }).connect()

  await assert.rejects(
    () => bridge.command('tabs.list', {}, { timeoutMs: 300 }),
    (error) => error.code === 'TIMEOUT',
  )

  const pending = bridge.command('tabs.list', {}, { timeoutMs: 5000 })
  setTimeout(() => fake.close(), 50)
  await assert.rejects(pending, (error) => error.code === 'CLIENT_CLOSED')
})

test('browser events are stored by tab and tab metadata is merged', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const fake = await new FakeExtension(bridge, { onCommand: () => ({}) }).connect()
  t.after(() => fake.close())

  fake.event(9, 'tab.updated', { tabId: 9, change: 'title', tab: { id: 9, title: 'Title', url: 'http://localhost/' } })
  fake.event(9, 'console', { level: 'error', text: 'boom', stack: 'at x', args: ['boom'] })
  fake.event(9, 'network.request', { id: 'r1', method: 'GET', url: 'http://localhost/api', type: 'fetch' })
  fake.event(9, 'network.response', { id: 'r1', status: 500, statusText: 'Server Error', mimeType: 'application/json', durationMs: 12 })
  fake.event(9, 'network.body', { id: 'r1', body: '{"error":"bad"}', size: 15 })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const consoleData = bridge.state.consoleFor(9)
  assert.equal(consoleData.entries.length, 1)
  assert.equal(consoleData.entries[0].level, 'error')
  const network = bridge.state.networkFor(9)
  assert.equal(network.requests.length, 1)
  assert.equal(network.requests[0].status, 500)
  const detail = bridge.state.networkGet(9, 'r1')
  assert.equal(detail.body, '{"error":"bad"}')
  assert.equal(bridge.state.getTabInfo(9).title, 'Title')
})

test('stop closes upgraded sockets even when hello never arrives', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${bridge.token}`)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const started = Date.now()
  await bridge.stop()
  assert.ok(Date.now() - started < 3000, 'bridge.stop() must not wait for an untracked upgraded socket')
  try { ws.close() } catch { /* ignore */ }
})

test('/hello hands the token only to extension clients', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)

  const plain = await (await fetch(`${bridge.url}/hello`)).json()
  assert.equal(plain.token, undefined)
  assert.equal(plain.autoPair, true)

  const web = await (await fetch(`${bridge.url}/hello`, { headers: { origin: 'https://evil.example' } })).json()
  assert.equal(web.token, undefined)

  const extension = await (await fetch(`${bridge.url}/hello`, {
    headers: { origin: 'chrome-extension://abcdefghijklmnop' },
  })).json()
  assert.match(extension.token, /^[a-f0-9]{64}$/)
  assert.equal(extension.token, bridge.token)

  const localClient = await (await fetch(`${bridge.url}/hello`, {
    headers: { 'x-dsh-bridge-client': 'auto' },
  })).json()
  assert.equal(localClient.token, bridge.token)
})

test('auto-pair can be disabled for locked-down deployments', async (t) => {
  const { bridge, cleanup } = await makeBridge({ autoPair: false })
  t.after(cleanup)
  const hello = await (await fetch(`${bridge.url}/hello`, {
    headers: { origin: 'chrome-extension://abcdefghijklmnop', 'x-dsh-bridge-client': 'auto' },
  })).json()
  assert.equal(hello.autoPair, false)
  assert.equal(hello.token, undefined)
})

test('WebSocket upgrade rejects a web page Origin even with a valid token', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const net = await import('node:net')
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(bridge.port, '127.0.0.1', () => {
      socket.write([
        'GET /ws?token=' + bridge.token + ' HTTP/1.1',
        `Host: 127.0.0.1:${bridge.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: https://evil.example',
        '',
        '',
      ].join('\r\n'))
    })
    let data = ''
    socket.on('data', (chunk) => { data += chunk.toString('utf8') })
    socket.on('end', () => resolve(data))
    socket.on('close', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); resolve(data) }, 2000)
  })
  assert.match(response, /HTTP\/1\.1 403/)
})

test('Edge and Chrome can stay connected together and tab commands route by owner', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)

  const edge = await new FakeExtension(bridge, {
    info: { brand: 'Edge', browser: 'chromium' },
    onCommand: async (action) => {
      if (action === 'tabs.list') return { tabs: [{ id: 101, title: 'Edge tab', url: 'http://edge/' }] }
      if (action === 'page.read') return { text: 'from Edge' }
      return {}
    },
  }).connect()
  t.after(() => edge.close())

  const chrome = await new FakeExtension(bridge, {
    info: { brand: 'Chrome', browser: 'chromium' },
    onCommand: async (action) => {
      if (action === 'tabs.list') return { tabs: [{ id: 201, title: 'Chrome tab', url: 'http://chrome/' }] }
      if (action === 'page.read') return { text: 'from Chrome' }
      return {}
    },
  }).connect()
  t.after(() => chrome.close())

  assert.equal(bridge.clientCount, 2)
  assert.equal(bridge.status().clients.length, 2)
  assert.equal(bridge.status().paired, true)

  const data = await bridge.listTabs()
  assert.deepEqual(data.tabs.map((tab) => tab.browser).sort(), ['Chrome', 'Edge'])
  assert.equal(data.tabs.find((tab) => tab.id === 101).browser, 'Edge')
  assert.equal(data.tabs.find((tab) => tab.id === 201).browser, 'Chrome')

  const fromChrome = await bridge.command('page.read', {}, { tabId: 201 })
  assert.equal(fromChrome.text, 'from Chrome')
  const fromEdge = await bridge.command('page.read', {}, { tabId: 101 })
  assert.equal(fromEdge.text, 'from Edge')
})
