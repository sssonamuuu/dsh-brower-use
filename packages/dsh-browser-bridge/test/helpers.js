import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BridgeServer } from '../lib/bridge-server.js'

export async function makeBridge(overrides = {}) {
  const stateDir = overrides.stateDir ?? await mkdtemp(path.join(tmpdir(), 'dsh-bridge-'))
  const bridge = new BridgeServer({
    port: 0,
    portRange: 1,
    stateDir,
    heartbeatMs: 2000,
    commandTimeoutMs: 1500,
    ...overrides,
  })
  await bridge.start()
  return {
    bridge,
    stateDir,
    async cleanup() {
      await bridge.stop()
      if (!overrides.keepState) await rm(stateDir, { recursive: true, force: true })
    },
  }
}

/** Minimal extension stand-in using Node's built-in WebSocket client. */
export class FakeExtension {
  constructor(bridge, { info = {}, onCommand = null } = {}) {
    this.bridge = bridge
    this.ws = null
    this.messages = []
    this.waiters = []
    this.commandHandler = onCommand
    this.info = {
      browser: 'chromium',
      brand: 'TestChrome',
      browserVersion: '999.0.0.0',
      extensionVersion: '0.1.0',
      platform: 'test',
      caps: ['tabs', 'dom', 'console', 'network', 'screenshot', 'input', 'frames'],
      ...info,
    }
  }

  async connect() {
    const url = `ws://127.0.0.1:${this.bridge.port}/ws?token=${this.bridge.token}`
    this.ws = new WebSocket(url)
    this.ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      this.messages.push(message)
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      }
      if (message.type === 'command') {
        this.#handleCommand(message)
      }
      if (message.type === 'ping') {
        this.send({ type: 'pong', ts: message.ts })
      }
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake extension open timeout')), 3000)
      this.ws.onopen = () => {
        clearTimeout(timer)
        this.send({ type: 'hello', protocol: 1, client: this.info })
        resolve()
      }
      this.ws.onerror = (event) => {
        clearTimeout(timer)
        reject(new Error(event.message || 'websocket error'))
      }
    })
    await this.waitFor((message) => message.type === 'hello_ok')
    return this
  }

  async #handleCommand(message) {
    try {
      const data = this.commandHandler
        ? await this.commandHandler(message.action, message.params ?? {}, message)
        : defaultCommand(message.action, message.params ?? {})
      try { this.send({ type: 'result', id: message.id, ok: true, data: data ?? {} }) } catch { /* closed while running */ }
    } catch (error) {
      try {
        this.send({
          type: 'result',
          id: message.id,
          ok: false,
          error: { code: error.code ?? 'INTERNAL', message: error.message },
        })
      } catch {
        // closed while running
      }
    }
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('fake extension is not open')
    this.ws.send(JSON.stringify(message))
  }

  event(tabId, event, data, seq) {
    this.send({ type: 'event', tabId, frameId: 0, seq: seq ?? 0, ts: Date.now(), event, data })
  }

  waitFor(predicate, timeoutMs = 3000) {
    for (const message of this.messages) {
      if (predicate(message)) return Promise.resolve(message)
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('timed out waiting for a websocket message'))
      }, timeoutMs)
      const done = waiter.resolve
      waiter.resolve = (message) => {
        clearTimeout(timer)
        done(message)
      }
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
  }
}

export function defaultCommand(action, params) {
  switch (action) {
    case 'tabs.list':
      return {
        tabs: [
          { id: 1, windowId: 1, index: 0, title: 'App', url: 'http://localhost:3000/', active: true, pinned: false, status: 'complete', audible: false, discarded: false },
          { id: 2, windowId: 1, index: 1, title: 'Docs', url: 'http://localhost:3000/docs', active: false, pinned: false, status: 'complete', audible: false, discarded: false },
        ],
      }
    case 'tabs.active':
      return { tab: { id: 1, windowId: 1, index: 0, title: 'App', url: 'http://localhost:3000/', active: true, pinned: false, status: 'complete', audible: false, discarded: false } }
    case 'tabs.activate':
      return { tab: { id: Number(params.tabId), windowId: 1, index: 1, title: 'Docs', url: 'http://localhost:3000/docs', active: true, pinned: false, status: 'complete', audible: false, discarded: false } }
    case 'tabs.open':
      return { tab: { id: 3, windowId: 1, index: 2, title: 'New', url: params.url, active: true, pinned: false, status: 'loading', audible: false, discarded: false } }
    case 'tabs.close':
    case 'tabs.reload':
    case 'tabs.back':
    case 'tabs.forward':
      return { ok: true }
    case 'page.snapshot':
      return {
        url: 'http://localhost:3000/',
        title: 'App',
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        scroll: { x: 0, y: 120, maxY: 2400 },
        interactive: [
          { ref: 'e1', role: 'textbox', name: 'Email', tag: 'input', type: 'text', value: 'a@b.c', selector: '#email' },
          { ref: 'e2', role: 'button', name: 'Save', tag: 'button', selector: '#save' },
        ],
        interactiveTotal: 2,
        text: 'Welcome to the app. Save your changes.',
        truncated: false,
      }
    case 'page.read':
      return { url: 'http://localhost:3000/', title: 'App', text: 'Hello world', truncated: false }
    case 'page.click':
      return { clicked: true, tag: 'button', name: 'Save', ref: params.ref, url: 'http://localhost:3000/' }
    case 'page.type':
      return { typed: true, tag: 'input', name: 'Email', ref: params.ref, submitted: Boolean(params.submit) }
    case 'page.press':
      return { pressed: true, target: 'input "Email"' }
    case 'page.scroll':
      return { scrollX: 0, scrollY: 1000, scrollHeight: 3000 }
    case 'page.wait':
      return { matched: true, ref: 'e9', elapsedMs: 120 }
    case 'page.eval':
      return { value: 'App', type: 'string' }
    case 'page.screenshot':
      return {
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        mimeType: 'image/png',
        tabId: 1,
      }
    default:
      return {}
  }
}
