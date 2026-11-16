/**
 * MV3 service worker: discovers the local DSH bridge, maintains the WebSocket,
 * routes commands to chrome.* APIs, and forwards page events.
 */
import {
  APP_ID,
  DEFAULT_PORT,
  EXTENSION_VERSION,
  HEARTBEAT_MS,
  PORT_RANGE,
  PROTOCOL_VERSION,
  STORAGE,
  detectBrowser,
} from './shared/protocol.js'
import { pageAction, pageEval } from './page-scripts.js'

const ALARM = 'dsh-browser-bridge-keepalive'
const BADGE_ON = '#16a34a'
const BADGE_OFF = '#dc2626'
const BADGE_PAIR = '#d97706'
const BADGE_ERR = '#7c3aed'
const AUTO_PAIR_HEADER = 'x-dsh-bridge-client'
const DEBUGGER_PROTOCOL = '1.3'
const DEBUGGER_IDLE_MS = 30_000
const DEBUGGER_MAX_BODY = 256 * 1024
const debuggerSessions = new Map()

let settings = { token: '', port: null, autoConnect: true }
let initPromise = null
let socket = null
let connected = false
let connecting = false
let helloOk = false
let helloInfo = null
let reconnectTimer = null
let reconnectDelay = 1000
let heartbeatTimer = null
let helloTimer = null
let lastPong = 0
let queue = []
let cancelled = new Set()
let seqByTab = new Map()
let armedTabs = new Set()
let intentionalClose = false
let connectionFailures = 0
const RELAY_EVENTS = new Set(['console', 'network.request', 'network.response', 'network.body', 'network.error', 'page.lifecycle'])

let status = {
  state: 'initializing',
  lastError: null,
  serverVersion: null,
  hello: null,
  activeTab: null,
  updatedAt: Date.now(),
}

/** Idempotent boot. */
async function init(force = false) {
  if (initPromise && !force) return initPromise
  initPromise = (async () => {
    await loadSettings()
    await ensureAlarm()
    updateBadge('…', BADGE_PAIR, 'DSH Browser Bridge')
    restoreArmedTabs().catch(() => {})
    // With auto-pair the extension never needs the user to type a code: it
    // discovers the bridge and receives a token over the CORS-gated handshake.
    connect().catch((error) => setError(error))
  })()
  return initPromise
}

async function loadSettings() {
  const data = await chrome.storage.local.get(Object.values(STORAGE))
  settings.token = typeof data[STORAGE.token] === 'string' ? data[STORAGE.token] : ''
  const port = Number(data[STORAGE.port])
  settings.port = Number.isFinite(port) && port > 0 ? port : null
  settings.autoConnect = data[STORAGE.autoConnect] !== false
  const storedArmed = data[STORAGE.armedTabs]
  armedTabs = new Set(Array.isArray(storedArmed)
    ? storedArmed.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [])
  helloInfo = data[STORAGE.serverVersion] ? { version: data[STORAGE.serverVersion] } : null
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch)
  if (patch[STORAGE.token] !== undefined) settings.token = String(patch[STORAGE.token] ?? '')
  if (patch[STORAGE.port] !== undefined) settings.port = Number(patch[STORAGE.port]) || null
  if (patch[STORAGE.autoConnect] !== undefined) settings.autoConnect = patch[STORAGE.autoConnect] !== false
}

async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM)
    if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 })
  } catch {
    // alarms are a keepalive optimization; the extension still works without them
  }
}

function setStatus(stateName, extra = {}) {
  status = { ...status, ...extra, state: stateName, updatedAt: Date.now() }
  broadcastStatus()
}

function setError(error) {
  const message = error instanceof Error ? error.message : String(error)
  status = { ...status, state: 'error', lastError: message, updatedAt: Date.now() }
  updateBadge('ERR', BADGE_ERR, `DSH Browser Bridge — ${message}`)
  broadcastStatus()
  chrome.storage.local.set({ [STORAGE.lastError]: message }).catch(() => {})
}

async function broadcastStatus() {
  try {
    await chrome.runtime.sendMessage({ type: 'dsh/status-changed', status: await composeStatus() })
  } catch {
    // popup/options may be closed; this is expected
  }
}

function updateBadge(text, color, title) {
  try {
    chrome.action.setBadgeText({ text })
    if (color) chrome.action.setBadgeBackgroundColor({ color })
    chrome.action.setTitle({ title: title || 'DSH Browser Bridge' })
  } catch {
    // ignore
  }
}

async function composeStatus() {
  let activeTab = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab) activeTab = tabInfo(tab)
  } catch {
    // ignore
  }
  return {
    ...status,
    connected,
    tokenSet: Boolean(settings.token),
    port: settings.port,
    serverVersion: settings.serverVersion ?? status.serverVersion,
    activeTab,
    autoConnect: settings.autoConnect !== false,
    browser: detectBrowser(),
    extensionVersion: EXTENSION_VERSION,
    bridgeProtocol: PROTOCOL_VERSION,
  }
}

/** Probe 47821..47830 for the DSH bridge. */
async function scanPorts() {
  const candidates = []
  const ports = Array.from({ length: PORT_RANGE }, (_, index) => DEFAULT_PORT + index)
  await Promise.all(ports.map(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hello`, {
        cache: 'no-store',
        headers: { [AUTO_PAIR_HEADER]: 'auto' },
        signal: AbortSignal.timeout(900),
      })
      if (!response.ok) return
      const hello = await response.json()
      if (hello?.app !== APP_ID || Number(hello?.protocol) !== PROTOCOL_VERSION) return
      candidates.push({ port: Number(hello.port) || port, hello })
    } catch {
      // not this port
    }
  }))
  candidates.sort((a, b) => a.port - b.port)
  return candidates
}

async function pair(code) {
  const normalized = String(code ?? '').trim()
  if (!/^\d{6}$/.test(normalized)) throw new Error('配对码必须是 6 位数字')
  const candidates = await scanPorts()
  if (candidates.length === 0) {
    throw new Error('没有找到 DSH bridge。确认 DSH 插件已启用、端口 47821-47830 未被占用。')
  }
  let lastError = null
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate.port}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: normalized }),
        signal: AbortSignal.timeout(4000),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.ok && data.token) {
        await saveSettings({
          [STORAGE.token]: data.token,
          [STORAGE.port]: candidate.port,
          [STORAGE.serverVersion]: data.serverVersion ?? candidate.hello?.version ?? null,
          [STORAGE.lastError]: null,
        })
        intentionalClose = false
        await connect()
        return { ok: true, port: candidate.port, serverVersion: data.serverVersion ?? candidate.hello?.version ?? null }
      }
      lastError = data.error === 'bad_code'
        ? '配对码不正确'
        : data.error === 'rate_limited'
          ? '尝试次数过多，请等一分钟再试'
          : data.error === 'pairing_disabled'
            ? '当前不允许配对新扩展（已有扩展连接或配对已关闭）'
            : data.error || `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError ?? '配对失败')
}

async function forget() {
  intentionalClose = true
  try {
    socket?.close(1000, 'forget token')
  } catch {
    // ignore
  }
  socket = null
  connected = false
  helloOk = false
  connectionFailures = 0
  stopHeartbeat()
  clearTimeout(reconnectTimer)
  await chrome.storage.local.remove([STORAGE.token, STORAGE.port, STORAGE.serverVersion, STORAGE.lastError]).catch(() => {})
  settings.token = ''
  settings.port = null
  updateBadge('…', BADGE_PAIR, 'DSH Browser Bridge — rediscovering')
  setStatus('pairing_required')
  // With auto-pair the token is disposable: rediscover immediately instead of
  // making the user wait for the keepalive alarm.
  setTimeout(() => { connect().catch(() => {}) }, 150)
  return { ok: true }
}

async function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return
  clearTimeout(reconnectTimer)
  connecting = true
  setStatus('connecting')
  try {
    const candidates = await scanPorts()
    if (candidates.length === 0) {
      if (!settings.token) {
        updateBadge('PAIR', BADGE_PAIR, 'DSH Browser Bridge — waiting for DSH')
        setStatus('pairing_required', { lastError: '没有找到 DSH bridge（127.0.0.1:47821-47830）' })
      }
      throw new Error('本地 DSH bridge 未找到（47821-47830）')
    }
    let target = candidates.find((item) => item.port === settings.port) ?? candidates[0]
    if (!settings.token) {
      const auto = target.hello?.token ? target : (candidates.find((item) => item.hello?.token) ?? target)
      if (!auto.hello?.token) {
        updateBadge('PAIR', BADGE_PAIR, 'DSH Browser Bridge — manual pairing required')
        setStatus('pairing_required', { lastError: 'bridge 未开启自动配对，请在扩展设置里输入配对码' })
        throw new Error('bridge 未开启自动配对；请在扩展设置里输入 browser_status 显示的配对码')
      }
      target = auto
      await saveSettings({
        [STORAGE.token]: auto.hello.token,
        [STORAGE.port]: auto.port,
        [STORAGE.serverVersion]: auto.hello.version ?? null,
        [STORAGE.lastError]: null,
      })
    }
    settings.port = target.port
    await chrome.storage.local.set({ [STORAGE.port]: target.port }).catch(() => {})
    await new Promise((resolve, reject) => {
      let ws
      try {
        ws = new WebSocket(`ws://127.0.0.1:${target.port}/ws?token=${encodeURIComponent(settings.token)}`)
      } catch (error) {
        reject(error)
        return
      }
      socket = ws
      helloOk = false
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      helloTimer = setTimeout(() => {
        if (!helloOk) {
          try {
            ws.close(4001, 'hello timeout')
          } catch {
            // ignore
          }
          fail(new Error('bridge handshake timed out'))
        }
      }, 6000)
      ws.onopen = () => {
        lastPong = Date.now()
        sendControl({ type: 'hello', protocol: PROTOCOL_VERSION, client: detectBrowser() })
        resolve()
      }
      ws.onmessage = (event) => {
        try {
          handleSocketMessage(JSON.parse(String(event.data)))
        } catch (error) {
          setError(error)
        }
      }
      ws.onerror = () => {
        if (!settled) fail(new Error('WebSocket 连接失败（token 可能已失效）'))
      }
      ws.onclose = (event) => {
        clearTimeout(helloTimer)
        if (socket !== ws) return
        socket = null
        connected = false
        helloOk = false
        stopHeartbeat()
        connectionFailures += 1
        if (connectionFailures >= 3 && settings.token) {
          // The bridge may have rotated its state file (or restarted on another
          // port). Drop the stale token and let the next attempt auto-discover.
          settings.token = ''
          chrome.storage.local.remove([STORAGE.token]).catch(() => {})
        }
        updateBadge(settings.token ? 'OFF' : 'PAIR', settings.token ? BADGE_OFF : BADGE_PAIR)
        if (!settled) {
          settled = true
          reject(new Error(event.reason || `WebSocket closed (${event.code})`))
        }
        if (!intentionalClose && settings.autoConnect) {
          setStatus('disconnected', { lastError: event.reason || `closed (${event.code})` })
          scheduleReconnect()
        } else {
          setStatus('disconnected')
        }
      }
    })
  } catch (error) {
    if (!settings.token) {
      updateBadge('PAIR', BADGE_PAIR, 'DSH Browser Bridge — waiting for DSH')
      setStatus('pairing_required', { lastError: error instanceof Error ? error.message : String(error) })
    } else {
      setError(error)
    }
    if (settings.autoConnect) scheduleReconnect()
  } finally {
    connecting = false
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(10_000, reconnectDelay * 2)
    connect().catch(() => {})
  }, reconnectDelay)
}

function handleSocketMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'pong') {
    lastPong = Date.now()
    return
  }
  if (message.type === 'ping') {
    sendControl({ type: 'pong', ts: message.ts ?? Date.now() })
    return
  }
  if (message.type === 'hello_ok') {
    connected = true
    helloOk = true
    connectionFailures = 0
    helloInfo = message
    clearTimeout(helloTimer)
    reconnectDelay = 1000
    settings.serverVersion = message.serverVersion ?? null
    chrome.storage.local.set({ [STORAGE.serverVersion]: settings.serverVersion }).catch(() => {})
    updateBadge('ON', BADGE_ON, `DSH Browser Bridge — connected to ${message.serverVersion ?? 'DSH'}`)
    setStatus('connected', { serverVersion: message.serverVersion ?? null, hello: message })
    startHeartbeat()
    flushQueue()
    syncActiveTab().catch(() => {})
    return
  }
  if (message.type === 'hello_error') {
    setError(new Error(`bridge rejected handshake: ${message.error ?? 'unknown'}`))
    intentionalClose = true
    try {
      socket?.close(4002, 'hello refused')
    } catch {
      // ignore
    }
    return
  }
  if (message.type === 'command') {
    if (cancelled.has(message.id)) {
      cancelled.delete(message.id)
      return
    }
    void handleCommand(message)
    return
  }
  if (message.type === 'cancel') {
    cancelled.add(String(message.id))
    if (cancelled.size > 200) cancelled.clear()
  }
}

function startHeartbeat() {
  stopHeartbeat()
  lastPong = Date.now()
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastPong > Math.max(60_000, HEARTBEAT_MS * 3)) {
      try {
        socket.close(4003, 'heartbeat timeout')
      } catch {
        // ignore
      }
      return
    }
    sendControl({ type: 'ping', ts: Date.now() })
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

function sendControl(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

function sendEvent(tabId, frameId, event, data, seq) {
  const message = {
    type: 'event',
    event,
    tabId: Number(tabId),
    frameId: Number(frameId) || 0,
    seq: seq ?? nextSeq(tabId),
    ts: Date.now(),
    data: data ?? {},
  }
  if (!sendControl(message)) {
    queue.push(message)
    if (queue.length > 1000) queue.splice(0, queue.length - 1000)
  }
}

function nextSeq(tabId) {
  const next = (seqByTab.get(Number(tabId)) ?? 0) + 1
  seqByTab.set(Number(tabId), next)
  return next
}

function flushQueue() {
  if (!helloOk) return
  const pending = queue
  queue = []
  for (const message of pending) {
    if (!sendControl(message)) {
      queue.push(message)
      break
    }
  }
}

async function syncActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) return
  sendEvent(tab.id, 0, 'tab.updated', { tabId: tab.id, change: 'active', tab: tabInfo(tab) })
  sendEvent(tab.id, 0, 'tab.activated', { tabId: tab.id, windowId: tab.windowId })
}

function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title ?? '',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl ?? '',
    active: tab.active === true,
    pinned: tab.pinned === true,
    status: tab.status ?? 'unknown',
    audible: tab.audible === true,
    discarded: tab.discarded === true,
  }
}

function isRestrictedUrl(url) {
  if (!url) return true
  const lower = url.toLowerCase()
  const prefixes = [
    'chrome://',
    'edge://',
    'brave://',
    'opera://',
    'vivaldi://',
    'devtools://',
    'chrome-extension://',
    'moz-extension://',
    'view-source:',
    'about:',
    'data:',
  ]
  if (prefixes.some((prefix) => lower.startsWith(prefix))) return true
  const webStores = [
    'https://chrome.google.com/webstore',
    'https://chromewebstore.google.com',
    'https://microsoftedge.microsoft.com/addons',
  ]
  return webStores.some((prefix) => lower.startsWith(prefix))
}

function injectable(url) {
  return /^(https?|file):/i.test(url) && !isRestrictedUrl(url)
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId: Number(tabId) }, DEBUGGER_PROTOCOL, () => {
      const error = chrome.runtime.lastError
      if (error) reject(makeError('DEBUGGER_ATTACH_FAILED', error.message))
      else resolve()
    })
  })
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId: Number(tabId) }, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

function debuggerSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params, (result) => {
      const error = chrome.runtime.lastError
      if (error) reject(makeError('DEBUGGER_COMMAND_FAILED', error.message))
      else resolve(result)
    })
  })
}

function touchDebugger(tabId) {
  const session = debuggerSessions.get(Number(tabId))
  if (!session) return
  clearTimeout(session.timer)
  session.timer = setTimeout(() => { detachDebugger(tabId).catch(() => {}) }, DEBUGGER_IDLE_MS)
  session.timer.unref?.()
}

async function attachDebugger(tabId) {
  const id = Number(tabId)
  if (debuggerSessions.has(id)) {
    touchDebugger(id)
    return { attached: true, tabId: id }
  }
  await debuggerAttach(id)
  try {
    await debuggerSend(id, 'Runtime.enable')
    await debuggerSend(id, 'Network.enable')
    await debuggerSend(id, 'Page.enable').catch(() => {})
  } catch (error) {
    await debuggerDetach(id)
    throw makeError('DEBUGGER_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  }
  debuggerSessions.set(id, { tabId: id, timer: null, responses: new Map(), attachedAt: Date.now() })
  touchDebugger(id)
  return { attached: true, tabId: id }
}

async function detachDebugger(tabId) {
  const id = Number(tabId)
  const session = debuggerSessions.get(id)
  if (!session) {
    armedTabs.delete(id)
    return { detached: false, tabId: id }
  }
  clearTimeout(session.timer)
  debuggerSessions.delete(id)
  await debuggerDetach(id)
  armedTabs.delete(id)
  await saveArmedTabs()
  return { detached: true, tabId: id }
}

async function saveArmedTabs() {
  await chrome.storage.local.set({ [STORAGE.armedTabs]: [...armedTabs] }).catch(() => {})
}

async function armTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId))
  if (!injectable(tab.url)) {
    throw makeError('RESTRICTED_PAGE', `page is not injectable: ${tab.url || ''}`)
  }
  await attachDebugger(tab.id)
  armedTabs.add(tab.id)
  await saveArmedTabs()
  return { armed: true, debuggerAttached: true, tabId: tab.id, tab: tabInfo(tab) }
}

async function disarmTab(tabId) {
  const id = Number(tabId)
  await detachDebugger(id)
  return { armed: false, debuggerAttached: false, tabId: id }
}

async function restoreArmedTabs() {
  let changed = false
  for (const tabId of [...armedTabs]) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab || !injectable(tab.url)) {
      armedTabs.delete(tabId)
      changed = true
      continue
    }
    attachDebugger(tabId).catch(() => {})
  }
  if (changed) await saveArmedTabs()
}

function cdpArgValue(arg) {
  if (!arg) return null
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) return arg.value
  if (arg.unserializableValue !== undefined) return arg.unserializableValue
  return arg.description ?? arg.type ?? null
}

function cdpStack(stackTrace) {
  if (!stackTrace || !Array.isArray(stackTrace.callFrames) || stackTrace.callFrames.length === 0) return undefined
  return stackTrace.callFrames.slice(0, 20).map((frame) => {
    const name = frame.functionName || '(anonymous)'
    const url = frame.url || ''
    return `${name} (${url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`
  }).join('\n')
}

function cdpTextLike(mimeType) {
  const type = String(mimeType || '').toLowerCase()
  if (/event-stream|octet-stream|image\/|video\/|audio\/|font\/|application\/(pdf|zip|gzip|x-rar)/.test(type)) return false
  return !type || /json|text|javascript|xml|x-www-form-urlencoded|graphql|html/.test(type)
}

function cdpClip(text, max = DEBUGGER_MAX_BODY) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]` : value
}

function handleDebuggerEvent(source, method, params) {
  const tabId = Number(source?.tabId)
  if (!Number.isFinite(tabId)) return
  const session = debuggerSessions.get(tabId)
  if (!session) return
  touchDebugger(tabId)
  if (method === 'Runtime.consoleAPICalled') {
    const type = String(params.type || 'log')
    const level = type === 'warning' ? 'warn' : type === 'assert' ? 'error' : type
    const args = (params.args || []).map(cdpArgValue)
    const text = args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
    sendEvent(tabId, 0, 'console', {
      level: ['log', 'info', 'warn', 'error', 'debug'].includes(level) ? level : 'log',
      args,
      text: cdpClip(text, 8000),
      ...(cdpStack(params.stackTrace) ? { stack: cdpStack(params.stackTrace) } : {}),
    })
    return
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {}
    const exception = details.exception || {}
    const text = exception.description || details.text || 'Uncaught exception'
    sendEvent(tabId, 0, 'console', {
      level: 'error',
      args: [cdpArgValue(exception)],
      text: cdpClip(text, 8000),
      ...(cdpStack(details.stackTrace) ? { stack: cdpStack(details.stackTrace) } : {}),
    })
    return
  }
  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {}
    session.responses.set(String(params.requestId), {
      startedAt: Number(params.timestamp) || 0,
      request,
    })
    sendEvent(tabId, 0, 'network.request', {
      id: String(params.requestId),
      method: String(request.method || 'GET').toUpperCase(),
      url: String(request.url || ''),
      type: String(params.type || 'fetch').toLowerCase(),
      ...(request.headers ? { requestHeaders: request.headers } : {}),
      ...(typeof request.postData === 'string' ? { body: cdpClip(request.postData, 4096) } : {}),
    })
    return
  }
  if (method === 'Network.responseReceived') {
    const response = params.response || {}
    const info = session.responses.get(String(params.requestId)) || {}
    const durationMs = info.startedAt ? Math.round((Number(params.timestamp) - info.startedAt) * 1000) : undefined
    sendEvent(tabId, 0, 'network.response', {
      id: String(params.requestId),
      status: Number(response.status),
      statusText: String(response.statusText || ''),
      responseHeaders: response.headers || {},
      mimeType: String(response.mimeType || ''),
      ...(Number.isFinite(durationMs) ? { durationMs } : {}),
      url: String(response.url || info.request?.url || ''),
    })
    info.response = response
    session.responses.set(String(params.requestId), info)
    return
  }
  if (method === 'Network.loadingFailed') {
    const info = session.responses.get(String(params.requestId))
    sendEvent(tabId, 0, 'network.error', {
      id: String(params.requestId),
      message: String(params.errorText || 'network failed'),
    })
    session.responses.delete(String(params.requestId))
    return
  }
  if (method === 'Network.loadingFinished') {
    const requestId = String(params.requestId)
    const info = session.responses.get(requestId)
    if (info && cdpTextLike(info.response?.mimeType)) {
      const headers = info.response?.headers || {}
      const declared = Number(headers['content-length'] ?? headers['Content-Length'])
      const encoded = Number(params.encodedDataLength)
      if ((!Number.isFinite(declared) || declared <= DEBUGGER_MAX_BODY * 2)
        && (!Number.isFinite(encoded) || encoded <= DEBUGGER_MAX_BODY * 2)) {
        debuggerSend(tabId, 'Network.getResponseBody', { requestId }).then((body) => {
          if (!body || body.base64Encoded || typeof body.body !== 'string') return
          sendEvent(tabId, 0, 'network.body', {
            id: requestId,
            body: cdpClip(body.body),
            truncated: body.body.length > DEBUGGER_MAX_BODY,
            size: body.body.length,
          })
        }).catch(() => {})
      }
    }
    session.responses.delete(requestId)
  }
}

function makeError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details) error.details = details
  return error
}

function mapScriptError(error, tab) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Cannot access|chrome:\/\/|extensions gallery|cannot be scripted|not allowed|The extensions gallery/i.test(message)) {
    return makeError('RESTRICTED_PAGE', `cannot inject into this page: ${message}`, { url: tab?.url })
  }
  if (/No tab with id|No frame|Frame .* not found|tab was closed/i.test(message)) {
    return makeError('NO_TAB', message)
  }
  if (/Could not establish connection|Receiving end does not exist/i.test(message)) {
    return makeError('NO_RECEIVER', message)
  }
  if (/Cannot find function|function is not/i.test(message)) {
    return makeError('INTERNAL', message)
  }
  return makeError('INTERNAL', message)
}

async function resolveTab(tabId) {
  if (tabId != null && Number.isFinite(Number(tabId))) {
    try {
      return await chrome.tabs.get(Number(tabId))
    } catch (error) {
      throw makeError('NO_TAB', `no tab with id ${tabId}: ${error.message}`)
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab) return tab
  const [fallback] = await chrome.tabs.query({ active: true })
  if (fallback) return fallback
  throw makeError('NO_ACTIVE_TAB', 'no active browser tab')
}

function callTabs(method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false
    const callback = (result) => {
      if (settled) return
      settled = true
      const error = chrome.runtime.lastError
      if (error) reject(makeError('TABS_API_FAILED', error.message))
      else resolve(result)
    }
    try {
      const returned = chrome.tabs[method](...args, callback)
      if (returned && typeof returned.then === 'function') {
        returned.then((value) => {
          if (!settled) { settled = true; resolve(value) }
        }, (error) => {
          if (!settled) { settled = true; reject(error) }
        })
      }
    } catch (error) {
      reject(error)
    }
  })
}

function captureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
      const error = chrome.runtime.lastError
      if (error) reject(makeError('SCREENSHOT_FAILED', error.message))
      else if (!dataUrl) reject(makeError('SCREENSHOT_FAILED', 'captureVisibleTab returned no data'))
      else resolve(dataUrl)
    })
  })
}

async function execPage(tab, func, args, world, frameId) {
  if (isRestrictedUrl(tab.url)) {
    throw makeError('RESTRICTED_PAGE', `page is not scriptable: ${tab.url}`)
  }
  const target = { tabId: tab.id }
  if (Number.isFinite(Number(frameId))) target.frameIds = [Number(frameId)]
  let results
  try {
    results = await chrome.scripting.executeScript({ target, world, func, args })
  } catch (error) {
    throw mapScriptError(error, tab)
  }
  const first = Array.isArray(results) ? results[0] : null
  if (!first) throw makeError('NO_RECEIVER', 'the page returned no result; it may have navigated or the frame is gone')
  const value = first.result
  if (value && typeof value === 'object' && value.__dshError) {
    const code = value.__dshError.code || 'INTERNAL'
    const message = value.__dshError.message || 'page script failed'
    throw makeError(
      code,
      code === 'CSP_BLOCKED' || code === 'EVAL_ERROR' ? `${code}: ${message}` : message,
      { stack: value.__dshError.stack },
    )
  }
  return value
}

/**
 * Per-command watchdog. `chrome.tabs.*` can hang forever when the service
 * worker loses its API binding (observed after long idle or an extension
 * reload); without a deadline the Host only sees silence and every later
 * command times out too. Answering with an error keeps the bridge diagnosable
 * and the message tells the user exactly what to do.
 */
const COMMAND_DEADLINES = new Map([
  ['tabs.list', 8000],
  ['tabs.active', 8000],
  ['tabs.activate', 8000],
  ['tabs.open', 15000],
  ['system.ping', 3000],
])
const DEFAULT_COMMAND_DEADLINE_MS = 20000

function commandDeadline(action) {
  return COMMAND_DEADLINES.get(action) ?? DEFAULT_COMMAND_DEADLINE_MS
}

function withDeadline(promise, ms, action) {
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `extension did not answer "${action}" within ${ms}ms — the service worker's chrome.* API looks unresponsive. Reload the extension at edge://extensions (or chrome://extensions) and retry.`,
      )
      error.code = 'EXTENSION_UNRESPONSIVE'
      error.details = { action, deadlineMs: ms }
      reject(error)
    }, ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

async function handleCommand(message) {
  const id = message.id
  const action = String(message.action || '')
  const params = { ...(message.params && typeof message.params === 'object' ? message.params : {}) }
  if (message.tabId != null) params.tabId = message.tabId
  if (message.frameId != null) params.frameId = message.frameId
  try {
    const data = await withDeadline(runAction(action, params), commandDeadline(action), action)
    if (cancelled.has(id)) {
      cancelled.delete(id)
      return
    }
    sendControl({ type: 'result', id, ok: true, data: data ?? {} })
  } catch (error) {
    if (cancelled.has(id)) {
      cancelled.delete(id)
      return
    }
    sendControl({
      type: 'result',
      id,
      ok: false,
      error: {
        code: error.code || 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
        ...(error.details ? { details: error.details } : {}),
      },
    })
  }
}

async function runAction(action, params) {
  const frameId = params.frameId
  switch (action) {
    case 'system.ping': {
      // Deliberately touches no browser API: proves the service worker is
      // alive and routing even when every tab call is stuck.
      return { pong: Date.now(), version: EXTENSION_VERSION, alive: true }
    }
    case 'collector.ensure': {
      return await armTab(params.tabId ?? (await resolveTab()).id)
    }
    case 'collector.disarm': {
      return await disarmTab(params.tabId ?? (await resolveTab()).id)
    }
    case 'tabs.list': {
      const tabs = await chrome.tabs.query({})
      return {
        tabs: tabs
          .filter((tab) => tab.id != null)
          .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))
          .map(tabInfo),
      }
    }
    case 'tabs.active': {
      const tab = await resolveTab()
      return { tab: tabInfo(tab) }
    }
    case 'tabs.activate': {
      const tab = await resolveTab(params.tabId)
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      const fresh = await chrome.tabs.get(tab.id)
      return { tab: tabInfo(fresh) }
    }
    case 'tabs.open': {
      const url = String(params.url || '')
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        throw makeError('BAD_REQUEST', `invalid url: ${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw makeError('BAD_REQUEST', 'only http(s) URLs can be opened')
      }
      const tab = await chrome.tabs.create({ url, active: params.active !== false })
      // A freshly created tab may report an empty url/title until the navigation starts.
      let fresh = tab
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        fresh = await chrome.tabs.get(tab.id).catch(() => fresh)
        if (fresh.status === 'complete' && fresh.url) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return { tab: tabInfo(fresh) }
    }
    case 'tabs.close': {
      const tab = await resolveTab(params.tabId)
      await chrome.tabs.remove(tab.id)
      return { closed: true }
    }
    case 'tabs.reload': {
      const tab = await resolveTab(params.tabId)
      await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true })
      return { reloaded: true }
    }
    case 'tabs.back': {
      const tab = await resolveTab(params.tabId)
      await callTabs('goBack', tab.id)
      return { ok: true }
    }
    case 'tabs.forward': {
      const tab = await resolveTab(params.tabId)
      await callTabs('goForward', tab.id)
      return { ok: true }
    }
    case 'page.snapshot': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'snapshot' }], 'ISOLATED', frameId)
    }
    case 'page.read': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'read' }], 'ISOLATED', frameId)
    }
    case 'page.click': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'click' }], 'ISOLATED', frameId)
    }
    case 'page.type': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'type' }], 'ISOLATED', frameId)
    }
    case 'page.press': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'press' }], 'ISOLATED', frameId)
    }
    case 'page.scroll': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'scroll' }], 'ISOLATED', frameId)
    }
    case 'page.wait': {
      const tab = await resolveTab(params.tabId)
      return await execPage(tab, pageAction, [{ ...params, action: 'wait' }], 'ISOLATED', frameId)
    }
    case 'page.eval': {
      const tab = await resolveTab(params.tabId)
      if (typeof params.expression !== 'string' || params.expression.trim() === '') {
        throw makeError('BAD_REQUEST', 'expression is required')
      }
      return await execPage(tab, pageEval, [params.expression, params.awaitPromise !== false], 'MAIN', frameId)
    }
    case 'page.screenshot': {
      const tab = await resolveTab(params.tabId)
      if (!injectable(tab.url)) {
        throw makeError('RESTRICTED_PAGE', `page is not capturable: ${tab.url}`)
      }
      const format = params.format === 'jpeg' ? 'jpeg' : 'png'
      const options = { format }
      if (format === 'jpeg') options.quality = Math.max(1, Math.min(100, Number(params.quality) || 80))
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
        await new Promise((resolve) => setTimeout(resolve, 180))
      }
      const dataUrl = await captureVisibleTab(tab.windowId, options)
      return {
        dataUrl,
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        tabId: tab.id,
      }
    }
    default:
      throw makeError('UNSUPPORTED_ACTION', `unknown browser action "${action}"`)
  }
}

/** Messages from popup/options and from the isolated relay. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false
  if (message.type === 'dsh/event') {
    handleRelayEvent(message, sender)
    return false
  }
  if (message.type === 'dsh/status-changed') return false
  handleUiMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  return true
})

function handleRelayEvent(message, sender) {
  const tabId = sender?.tab?.id
  if (tabId == null) return
  const payload = message.payload
  if (!payload || typeof payload.type !== 'string') return
  if (!RELAY_EVENTS.has(payload.type)) return
  if (payload.data && typeof payload.data === 'object') {
    const size = estimateSize(payload.data)
    if (size > 512 * 1024) return
  }
  let seq = Number(payload.seq) || 0
  if (seq > 0) seqByTab.set(tabId, Math.max(seqByTab.get(tabId) ?? 0, seq))
  else seq = nextSeq(tabId)
  sendEvent(tabId, sender.frameId ?? 0, payload.type, payload.data, seq)
}

function estimateSize(value) {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

async function handleUiMessage(message) {
  await init()
  switch (message.type) {
    case 'dsh/get-status':
      return { ok: true, status: await composeStatus() }
    case 'dsh/pair':
      try {
        return await pair(message.code)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    case 'dsh/reconnect':
      intentionalClose = false
      await connect()
      return { ok: true, status: await composeStatus() }
    case 'dsh/forget':
      return await forget()
    case 'dsh/save': {
      const patch = {}
      if (message.token !== undefined) patch[STORAGE.token] = String(message.token ?? '').trim()
      if (message.port !== undefined) patch[STORAGE.port] = Number(message.port) || null
      if (message.autoConnect !== undefined) patch[STORAGE.autoConnect] = message.autoConnect !== false
      if (patch[STORAGE.token] !== undefined && patch[STORAGE.token] !== '' && !/^[a-f0-9]{64}$/.test(patch[STORAGE.token])) {
        return { ok: false, error: 'token 必须是 64 位十六进制字符串' }
      }
      await saveSettings(patch)
      if (settings.token) {
        intentionalClose = false
        await connect()
      }
      return { ok: true, status: await composeStatus() }
    }
    case 'dsh/scan': {
      const candidates = await scanPorts()
      return { ok: true, candidates: candidates.map((item) => ({ port: item.port, hello: item.hello })) }
    }
    case 'dsh/test': {
      const candidates = await scanPorts()
      return {
        ok: candidates.length > 0,
        candidates: candidates.map((item) => ({ port: item.port, hello: item.hello })),
        status: await composeStatus(),
      }
    }
    default:
      return { ok: false, error: `unknown message type: ${message.type}` }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  init(true).catch((error) => setError(error))
})
chrome.runtime.onStartup.addListener(() => {
  init(true).catch((error) => setError(error))
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return
  if (!connected && settings.autoConnect) connect().catch(() => {})
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!connected) return
  sendEvent(activeInfo.tabId, 0, 'tab.activated', { tabId: activeInfo.tabId, windowId: activeInfo.windowId })
  chrome.tabs.get(activeInfo.tabId)
    .then((tab) => sendEvent(tab.id, 0, 'tab.updated', { tabId: tab.id, change: 'active', tab: tabInfo(tab) }))
    .catch(() => {})
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!connected) return
  if (!changeInfo.url && !changeInfo.title && !changeInfo.status) return
  const change = changeInfo.url ? 'url' : changeInfo.title ? 'title' : 'status'
  sendEvent(tabId, 0, 'tab.updated', { tabId, change, tab: tabInfo(tab) })
})
chrome.tabs.onRemoved.addListener((tabId) => {
  if (armedTabs.delete(Number(tabId))) saveArmedTabs().catch(() => {})
  if (!connected) return
  sendEvent(tabId, 0, 'tab.removed', { tabId })
  seqByTab.delete(tabId)
})

chrome.debugger.onEvent.addListener(handleDebuggerEvent)
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = Number(source?.tabId)
  if (!Number.isFinite(tabId)) return
  debuggerSessions.delete(tabId)
  if (armedTabs.delete(tabId)) saveArmedTabs().catch(() => {})
  if (reason) setStatus('debugger-detached', { lastError: null })
})

init().catch((error) => setError(error))
