/**
 * Local HTTP + WebSocket bridge between the DSH host plugin and the browser
 * extension.
 *
 * Security posture:
 * - bind loopback only (default 127.0.0.1);
 * - WebSocket requires the persisted bearer token;
 * - pairing requires a 6 digit code that rotates per host start, rate limited;
 * - CORS headers are only returned to extension origins.
 *
 * @module dsh-browser-bridge/bridge-server
 */
import { createServer } from 'node:http'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import path from 'node:path'
import { BrowserState } from './browser-state.js'
import { isWebSocketUpgrade, upgradeSocket } from './ws.js'
import {
  APP_ID,
  BridgeError,
  CAPABILITIES,
  DEFAULT_PORT,
  DEFAULT_PORT_RANGE,
  ERROR,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
} from './protocol.js'

const LOOPBACK = '127.0.0.1'
const MAX_BODY = 8 * 1024
const MAX_WS_PAYLOAD = 16 * 1024 * 1024

/**
 * Create and start a bridge. The returned promise resolves once an HTTP
 * listener is bound (or rejects if every port in the range is unavailable).
 */
export class BridgeServer extends EventEmitter {
  #config
  #store
  #auth = { token: '', pairCode: '000000' }
  #server = null
  #port = null
  #clients = new Set()
  #sockets = new Set()
  #active = null
  /** tab id -> owning browser client; lets page commands follow the right browser. */
  #tabOwners = new Map()
  #pending = new Map()
  #nextCommandId = 1
  #heartbeatTimer = null
  #pairAttempts = new Map()
  #clientSeq = 1
  #startedAt = Date.now()
  #stopped = false
  #startError = null
  #logger

  constructor(config = {}) {
    super()
    this.#config = {
      host: LOOPBACK,
      port: DEFAULT_PORT,
      portRange: DEFAULT_PORT_RANGE,
      heartbeatMs: 20_000,
      commandTimeoutMs: 15_000,
      pairingEnabled: true,
      autoPair: true,
      stateDir: path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'browser-bridge'),
      maxConsole: 2000,
      maxNetwork: 1000,
      maxBodyBytes: 262_144,
      pairWindowMs: 60_000,
      pairMaxFailures: 5,
      ...config,
    }
    this.#logger = config.logger ?? null
    this.#store = new BrowserState({
      maxConsole: this.#config.maxConsole,
      maxNetwork: this.#config.maxNetwork,
      maxBodyBytes: this.#config.maxBodyBytes,
    })
  }

  get port() {
    return this.#port
  }

  get host() {
    return this.#config.host
  }

  get url() {
    return this.#port ? `http://${this.#config.host}:${this.#port}` : null
  }

  get clientCount() {
    return this.#clients.size
  }

  get activeClient() {
    return this.#active
  }

  get state() {
    return this.#store
  }

  get pairingCode() {
    return this.#auth.pairCode
  }

  get token() {
    return this.#auth.token
  }

  get stateFile() {
    return path.join(this.#config.stateDir, 'state.json')
  }

  /** Start listening; tries `port .. port+portRange-1`. */
  async start() {
    if (this.#server) return this
    this.#auth = await loadState(this.#config.stateDir, this.#config)
    const server = createServer((req, res) => this.#handleHttp(req, res))
    server.on('connection', (socket) => {
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
    })
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head))
    server.on('error', (error) => {
      this.#logger?.error?.(`[browser-bridge] server error: ${error.message}`)
    })
    const requested = Number(this.#config.port)
    const start = Number.isFinite(requested) ? Math.max(0, requested) : DEFAULT_PORT
    const range = Math.max(1, Math.min(100, Number(this.#config.portRange) || DEFAULT_PORT_RANGE))
    let lastError = null
    for (let offset = 0; offset < range; offset++) {
      const candidate = start + offset
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = () => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(candidate, this.#config.host)
        })
        this.#port = server.address()?.port ?? candidate
        this.#server = server
        break
      } catch (error) {
        lastError = error
        if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') break
      }
    }
    if (!this.#server) {
      this.#startError = lastError?.message ?? 'unknown error'
      throw new BridgeError(
        ERROR.NO_BRIDGE,
        `browser bridge could not bind ${this.#config.host}:${start}..${start + range - 1}: ${lastError?.message ?? 'unknown error'}`,
      )
    }
    this.#heartbeatTimer = setInterval(() => this.#sweepHeartbeats(), Math.max(1000, this.#config.heartbeatMs / 2))
    this.#heartbeatTimer.unref?.()
    this.#logger?.info?.(
      `[browser-bridge] listening on ws://${this.#config.host}:${this.#port} pair=${this.#auth.pairCode}`,
    )
    return this
  }

  /** Stop listening, close clients, and reject pending commands. */
  async stop() {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    for (const client of [...this.#clients]) client.conn.close(1001, 'host shutting down')
    this.#clients.clear()
    this.#active = null
    this.#tabOwners.clear()
    this.#rejectAll(new BridgeError(ERROR.CLIENT_CLOSED, 'browser bridge stopped'))
    const server = this.#server
    this.#server = null
    for (const socket of [...this.#sockets]) {
      try { socket.destroy() } catch { /* ignore */ }
    }
    this.#sockets.clear()
    if (server) {
      await Promise.race([
        new Promise((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections?.()
        }),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
    }
  }

  /**
   * Pick the client a command should go to. Explicit `clientId` wins; a tab id
   * follows the browser that reported that tab; otherwise use the most recent
   * connection. This is what lets Edge and Chrome stay connected together.
   * @param {{ clientId?: string, tabId?: number, browser?: string }} [options]
   * @returns {object|null}
   */
  #resolveClient(options = {}) {
    if (options.clientId != null) {
      for (const client of this.#clients) {
        if (client.id === options.clientId && client.conn.open) return client
      }
      return null
    }
    if (Number.isFinite(Number(options.tabId))) {
      const owner = this.#tabOwners.get(Number(options.tabId))
      if (owner && this.#clients.has(owner) && owner.conn.open) return owner
    }
    if (options.browser) {
      const wanted = String(options.browser).toLowerCase()
      const match = [...this.#clients].find((client) => client.conn.open && (`${client.info.brand ?? ''} ${client.info.browser ?? ''}`).toLowerCase().includes(wanted))
      if (match) return match
    }
    return this.#active && this.#active.conn.open ? this.#active : this.#clients.values().next().value ?? null
  }

  /** Record every tab returned by one client so later page commands can route by tab id. */
  #rememberTabList(client, tabs) {
    if (!Array.isArray(tabs)) return
    for (const tab of tabs) {
      if (tab?.id != null) this.#tabOwners.set(Number(tab.id), client)
    }
  }

  /** Record one tab result (open/activate) against its client. */
  #rememberTab(client, tab) {
    if (tab?.id != null) this.#tabOwners.set(Number(tab.id), client)
  }

  /**
   * Ask every connected browser for its tabs and merge the results.
   * One browser failing does not hide the others' tabs.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{tabs: object[], clients: object[], errors: object[]}>}
   */
  async listTabs(options = {}) {
    const wanted = options.browser ? String(options.browser).toLowerCase() : ''
    const clients = [...this.#clients].filter((client) => client.conn.open
      && (!wanted || `${client.info.brand ?? ''} ${client.info.browser ?? ''}`.toLowerCase().includes(wanted)))
    if (clients.length === 0) {
      throw new BridgeError(
        ERROR.NO_CLIENT,
        `browser extension is not connected. Open the DSH Browser Bridge extension, click Pair, and enter code ${this.#auth.pairCode}.`,
        { pairingCode: this.#auth.pairCode, port: this.#port },
      )
    }
    const settled = await Promise.allSettled(
      clients.map((client) => this.command('tabs.list', {}, {
        ...options,
        clientId: client.id,
        requiredCaps: ['tabs'],
      })),
    )
    const tabs = []
    const errors = []
    settled.forEach((result, index) => {
      const client = clients[index]
      if (result.status === 'fulfilled') {
        const list = result.value?.tabs ?? []
        this.#rememberTabList(client, list)
        for (const tab of list) {
          tabs.push({
            ...tab,
            browser: client.info.brand ?? client.info.browser ?? 'Browser',
            browserEngine: client.info.browser,
            browserVersion: client.info.browserVersion,
            clientId: client.id,
          })
        }
      } else {
        errors.push({
          clientId: client.id,
          browser: client.info.brand ?? client.info.browser ?? 'Browser',
          code: result.reason?.code ?? 'ERROR',
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    })
    return {
      tabs,
      clients: clients.map((client) => ({
        id: client.id,
        browser: client.info.browser,
        brand: client.info.brand,
        browserVersion: client.info.browserVersion,
      })),
      errors,
    }
  }

  /**
   * Send a command to the connected extension.
   * @param {string} action
   * @param {object} [params]
   * @param {{ tabId?: number, frameId?: number, timeoutMs?: number, signal?: AbortSignal, requiredCaps?: string[], clientId?: string }} [options]
   */
  async command(action, params = {}, options = {}) {
    if (this.#stopped) throw new BridgeError(ERROR.NO_BRIDGE, 'browser bridge is stopped')
    const client = this.#resolveClient(options)
    if (!client || !client.conn.open) {
      throw new BridgeError(
        ERROR.NO_CLIENT,
        `browser extension is not connected. Open the DSH Browser Bridge extension, click Pair, and enter code ${this.#auth.pairCode}.`,
        { pairingCode: this.#auth.pairCode, port: this.#port },
      )
    }
    if (options.signal?.aborted) throw new BridgeError(ERROR.ABORTED, 'command aborted before dispatch')
    const caps = Array.isArray(client.info.caps) ? client.info.caps : []
    for (const cap of options.requiredCaps ?? []) {
      if (!caps.includes(cap)) {
        throw new BridgeError(
          ERROR.CAPABILITY_MISSING,
          `browser "${client.info.brand ?? client.info.browser}" does not support capability "${cap}"`,
          { cap, caps },
        )
      }
    }
    const id = `c_${this.#nextCommandId++}`
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || this.#config.commandTimeoutMs)
    const payload = {
      type: 'command',
      id,
      action,
      params,
      ...(Number.isFinite(Number(options.tabId)) ? { tabId: Number(options.tabId) } : {}),
      ...(Number.isFinite(Number(options.frameId)) ? { frameId: Number(options.frameId) } : {}),
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        cleanup()
        try {
          client.conn.send(JSON.stringify({ type: 'cancel', id }))
        } catch {
          // ignore
        }
        reject(new BridgeError(ERROR.TIMEOUT, `browser command "${action}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      const onAbort = () => {
        this.#pending.delete(id)
        cleanup()
        try {
          client.conn.send(JSON.stringify({ type: 'cancel', id }))
        } catch {
          // ignore
        }
        reject(new BridgeError(ERROR.ABORTED, `browser command "${action}" aborted`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
      }
      this.#pending.set(id, { resolve, reject, cleanup, action, client })
      options.signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        client.conn.send(JSON.stringify(payload))
      } catch (error) {
        this.#pending.delete(id)
        cleanup()
        reject(new BridgeError(ERROR.CLIENT_CLOSED, `failed to send command: ${error.message}`))
      }
    })
  }

  /** Human/tool-facing status snapshot. */
  status() {
    return {
      listening: this.#server != null,
      host: this.#config.host,
      port: this.#port,
      protocol: PROTOCOL_VERSION,
      version: PACKAGE_VERSION,
      paired: this.#clients.size > 0,
      autoPair: this.#config.autoPair !== false,
      tokenHandoff: 'extension-origin-or-explicit-client-header',
      pairingCode: this.#auth.pairCode,
      stateFile: this.stateFile,
      clients: [...this.#clients].map((client) => ({
        id: client.id,
        browser: client.info.browser,
        brand: client.info.brand,
        browserVersion: client.info.browserVersion,
        extensionVersion: client.info.extensionVersion,
        platform: client.info.platform,
        caps: client.info.caps,
        connectedAt: client.connectedAt,
        lastSeen: client.lastSeen,
      })),
      stats: this.#store.stats(),
      uptimeMs: Date.now() - this.#startedAt,
      error: this.#startError ?? null,
    }
  }

  #handleHttp(req, res) {
    const security = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    const cors = extensionOrigin(origin)
    if (cors) {
      security['Access-Control-Allow-Origin'] = origin
      security['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
      security['Access-Control-Allow-Headers'] = 'content-type, x-dsh-bridge-client'
      security['Access-Control-Allow-Private-Network'] = 'true'
      security.Vary = 'Origin'
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(cors ? 204 : 403, security)
      res.end()
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', `http://${this.#config.host}`)
    } catch {
      respondJson(res, 400, { ok: false, error: 'bad_url' }, security)
      return
    }
    if (url.pathname === '/hello' && req.method === 'GET') {
      const autoToken = this.#config.autoPair !== false && isAutoPairClient(req, origin)
      respondJson(res, 200, {
        app: APP_ID,
        protocol: PROTOCOL_VERSION,
        version: PACKAGE_VERSION,
        port: this.#port,
        autoPair: this.#config.autoPair !== false,
        pairing: this.#config.pairingEnabled !== false && this.#clients.size === 0,
        // The token is only handed to extension origins or clients that prove
        // they are not a cross-origin web page (custom header + CORS gate).
        ...(autoToken ? { token: this.#auth.token } : {}),
      }, security)
      return
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      respondJson(res, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        clients: this.#clients.size,
        active: this.#active
          ? {
              browser: this.#active.info.browser,
              brand: this.#active.info.brand,
              version: this.#active.info.browserVersion,
            }
          : null,
        browsers: [...this.#clients].map((client) => ({
          id: client.id,
          browser: client.info.browser,
          brand: client.info.brand,
          version: client.info.browserVersion,
        })),
        stats: this.#store.stats(),
      }, security)
      return
    }
    if (url.pathname === '/pair' && req.method === 'POST') {
      this.#handlePair(req, res, security, origin)
      return
    }
    respondJson(res, 404, { ok: false, error: 'not_found' }, security)
  }

  #handlePair(req, res, headers, origin) {
    if (this.#config.pairingEnabled === false) {
      respondJson(res, 403, { ok: false, error: 'pairing_disabled' }, headers)
      return
    }
    if (this.#clients.size > 0 && this.#config.allowRepair !== true) {
      respondJson(res, 403, { ok: false, error: 'pairing_disabled', reason: 'already_connected' }, headers)
      return
    }
    const ip = req.socket.remoteAddress ?? 'unknown'
    const attempt = this.#pairAttempts.get(ip)
    const now = Date.now()
    if (attempt && attempt.count >= this.#config.pairMaxFailures && now < attempt.resetAt) {
      respondJson(res, 429, { ok: false, error: 'rate_limited', retryAfterMs: attempt.resetAt - now }, headers)
      return
    }
    readBody(req, MAX_BODY)
      .then((body) => {
        let payload
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          respondJson(res, 400, { ok: false, error: 'bad_request' }, headers)
          return
        }
        const code = String(payload.code ?? '').trim()
        if (!/^\d{6}$/.test(code)) {
          respondJson(res, 400, { ok: false, error: 'bad_request' }, headers)
          return
        }
        const ok = safeEqual(code, this.#auth.pairCode)
        if (!ok) {
          const entry = attempt && now < attempt.resetAt
            ? attempt
            : { count: 0, resetAt: now + this.#config.pairWindowMs }
          entry.count += 1
          this.#pairAttempts.set(ip, entry)
          this.#logger?.warn?.(`[browser-bridge] bad pairing code from ${ip}`)
          respondJson(res, 401, { ok: false, error: 'bad_code', attemptsLeft: Math.max(0, this.#config.pairMaxFailures - entry.count) }, headers)
          return
        }
        this.#pairAttempts.delete(ip)
        respondJson(res, 200, {
          ok: true,
          token: this.#auth.token,
          protocol: PROTOCOL_VERSION,
          port: this.#port,
          serverVersion: PACKAGE_VERSION,
        }, headers)
      })
      .catch((error) => {
        respondJson(res, 400, { ok: false, error: 'bad_request', message: error.message }, headers)
      })
  }

  #handleUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url ?? '/', `http://${this.#config.host}`)
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (url.pathname !== '/ws' || !isWebSocketUpgrade(req)) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    // A browser page's WebSocket always carries an Origin. Only extension
    // origins may use the bridge; a http(s) page must never be able to command
    // the extension. Origin-less clients are local processes (same trust tier
    // as reading the state file) and are allowed with the token.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    if (origin && !extensionOrigin(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    const token = url.searchParams.get('token') ?? ''
    if (!safeEqual(token, this.#auth.token)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    let conn
    try {
      conn = upgradeSocket(req, socket, head, { maxPayload: MAX_WS_PAYLOAD })
    } catch (error) {
      this.#logger?.warn?.(`[browser-bridge] websocket upgrade failed: ${error.message}`)
      socket.destroy()
      return
    }
    const client = {
      id: `x_${this.#clientSeq++}`,
      conn,
      info: { browser: 'chromium', brand: 'Chromium', browserVersion: 'unknown', extensionVersion: 'unknown', platform: 'unknown', caps: [...CAPABILITIES] },
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      helloSent: false,
      helloTimer: null,
    }
    client.helloTimer = setTimeout(() => {
      if (!client.helloSent) {
        try {
          client.conn.send(JSON.stringify({ type: 'hello_error', error: 'hello_timeout', serverProtocol: PROTOCOL_VERSION }))
        } catch {
          // ignore
        }
        client.conn.close(4001, 'hello timeout')
      }
    }, 5000)
    client.helloTimer.unref?.()
    conn.on('message', (text) => this.#handleWsMessage(client, text))
    conn.on('close', () => this.#dropClient(client, 'connection closed'))
    conn.on('error', (error) => this.#logger?.warn?.(`[browser-bridge] ws error: ${error.message}`))
  }

  #handleWsMessage(client, text) {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    client.lastSeen = Date.now()
    if (msg.type === 'ping') {
      try {
        client.conn.send(JSON.stringify({ type: 'pong', ts: msg.ts ?? Date.now() }))
      } catch {
        // ignore
      }
      return
    }
    if (msg.type === 'hello') {
      if (client.helloSent) return
      if (Number(msg.protocol) !== PROTOCOL_VERSION) {
        try {
          client.conn.send(JSON.stringify({ type: 'hello_error', error: 'protocol_mismatch', serverProtocol: PROTOCOL_VERSION }))
        } catch {
          // ignore
        }
        client.conn.close(4002, 'protocol mismatch')
        return
      }
      const info = normalizeClientInfo(msg.client)
      client.info = info
      client.helloSent = true
      clearTimeout(client.helloTimer)
      // Only replace a stale socket from the same browser. Different browsers
      // (e.g. Edge and Chrome) must remain connected simultaneously.
      const clientKey = `${info.browser ?? ''}|${info.brand ?? ''}`
      for (const other of this.#clients) {
        if (other !== client && `${other.info.browser ?? ''}|${other.info.brand ?? ''}` === clientKey) {
          other.conn.close(4000, 'replaced by a new connection from the same browser')
        }
      }
      this.#clients.add(client)
      this.#active = client
      try {
        client.conn.send(JSON.stringify({
          type: 'hello_ok',
          protocol: PROTOCOL_VERSION,
          serverVersion: PACKAGE_VERSION,
          sessionId: client.id,
          heartbeatMs: this.#config.heartbeatMs,
          limits: { maxCommandBytes: 8 * 1024 * 1024, maxEventBytes: 262_144 },
        }))
      } catch {
        // ignore
      }
      this.#logger?.info?.(
        `[browser-bridge] extension connected: ${info.brand} ${info.browserVersion} (${info.extensionVersion})`,
      )
      this.emit('client-connected', this.status())
      return
    }
    if (!client.helloSent) return
    if (msg.type === 'result') {
      const pending = this.#pending.get(String(msg.id))
      if (!pending) return
      this.#pending.delete(String(msg.id))
      pending.cleanup()
      if (msg.ok) {
        const data = msg.data ?? {}
        if (pending.action === 'tabs.list') this.#rememberTabList(client, data.tabs)
        else if (pending.action === 'tabs.open' || pending.action === 'tabs.activate') this.#rememberTab(client, data.tab)
        pending.resolve(data)
      } else {
        const error = msg.error && typeof msg.error === 'object' ? msg.error : {}
        pending.reject(new BridgeError(error.code ?? ERROR.INTERNAL, error.message ?? 'browser command failed', error.details))
      }
      return
    }
    if (msg.type === 'event') {
      // The extension reports the tab/frame it belongs to; seq is per-tab.
      const eventTabId = Number(msg.tabId)
      if (Number.isFinite(eventTabId)) {
        if (msg.event === 'tab.removed') this.#tabOwners.delete(eventTabId)
        else this.#tabOwners.set(eventTabId, client)
      }
      if (msg.event === 'tab.updated' && msg.data?.tab?.id != null) {
        this.#tabOwners.set(Number(msg.data.tab.id), client)
      }
      this.#store.handle(msg)
      this.emit('browser-event', msg)
      return
    }
    // Unknown message types are ignored for forward compatibility.
  }

  #dropClient(client, reason) {
    if (!this.#clients.delete(client)) return
    if (this.#active === client) {
      this.#active = this.#clients.values().next().value ?? null
    }
    for (const [tabId, owner] of [...this.#tabOwners]) {
      if (owner === client) this.#tabOwners.delete(tabId)
    }
    clearTimeout(client.helloTimer)
    for (const [id, pending] of [...this.#pending]) {
      if (pending.client !== client) continue
      this.#pending.delete(id)
      pending.cleanup()
      pending.reject(new BridgeError(ERROR.CLIENT_CLOSED, `browser extension disconnected (${reason})`))
    }
    this.emit('client-disconnected', { reason, status: this.status() })
  }

  #sweepHeartbeats() {
    const deadline = Date.now() - Math.max(15_000, this.#config.heartbeatMs * 3)
    for (const client of [...this.#clients]) {
      if (client.lastSeen < deadline) {
        this.#logger?.warn?.('[browser-bridge] heartbeat timeout; closing extension connection')
        client.conn.close(4003, 'heartbeat timeout')
      }
    }
  }

  #rejectAll(error) {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id)
      pending.cleanup()
      pending.reject(error)
    }
  }

}

function respondJson(res, status, value, headers) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
  } catch {
    // ignore
  }
  socket.destroy()
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

function extensionOrigin(origin) {
  return origin.startsWith('chrome-extension://') || origin.startsWith('extension://') || origin.startsWith('moz-extension://')
}

/**
 * Auto-pairing hands the token only to requests that are either from an
 * extension origin, or that set a custom header (which a cross-origin web page
 * cannot do without a CORS preflight this server refuses). A plain web page
 * fetch cannot read the token.
 */
function isAutoPairClient(req, origin) {
  if (extensionOrigin(origin)) return true
  return String(req.headers['x-dsh-bridge-client'] ?? '').toLowerCase() === 'auto'
}

function normalizeClientInfo(input) {
  const value = input && typeof input === 'object' ? input : {}
  const caps = Array.isArray(value.caps)
    ? value.caps.filter((cap) => typeof cap === 'string' && CAPABILITIES.includes(cap))
    : [...CAPABILITIES]
  return {
    browser: sanitize(value.browser, 32) || 'chromium',
    brand: sanitize(value.brand, 48) || 'Chromium',
    browserVersion: sanitize(value.browserVersion, 64) || 'unknown',
    extensionVersion: sanitize(value.extensionVersion, 32) || 'unknown',
    platform: sanitize(value.platform, 48) || 'unknown',
    caps,
  }
}

function sanitize(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

async function loadState(stateDir, config) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {})
  const file = path.join(stateDir, 'state.json')
  let existing = null
  try {
    existing = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    existing = null
  }
  const token = typeof existing?.token === 'string' && /^[a-f0-9]{64}$/.test(existing.token)
    ? existing.token
    : randomBytes(32).toString('hex')
  const pairCode = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const state = {
    protocol: PROTOCOL_VERSION,
    token,
    pairCode,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    app: APP_ID,
  }
  try {
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await chmod(file, 0o600).catch(() => {})
  } catch {
    // A read-only DSH_HOME still works for this process: token lives in memory.
    void config
  }
  return state
}
