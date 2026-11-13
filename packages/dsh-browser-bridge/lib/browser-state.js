/**
 * In-memory event store for console and network observations.
 *
 * The extension streams events; tools read this store synchronously. Keeping
 * the store on the host means a tool call still works while the MV3 service
 * worker is asleep, and a tab that navigated away keeps its recent errors.
 *
 * @module dsh-browser-bridge/browser-state
 */

const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug'])

/** @typedef {{ seq: number, ts: number, frameId: number, level: string, text: string, args: unknown[], stack?: string, url?: string }} ConsoleEntry */
/** @typedef {{ id: string, tabId: number, frameId: number, seq: number, method: string, url: string, type: string, requestHeaders?: Record<string,string>, requestBody?: string, startedAt: number, status?: number, statusText?: string, responseHeaders?: Record<string,string>, mimeType?: string, durationMs?: number, body?: string, bodySize?: number, bodyTruncated?: boolean, error?: string }} NetworkRecord */

export class BrowserState {
  #maxConsole
  #maxNetwork
  #maxBodyBytes
  #tabs = new Map()
  #activeTabId = null

  constructor({ maxConsole = 2000, maxNetwork = 1000, maxBodyBytes = 262_144 } = {}) {
    this.#maxConsole = maxConsole
    this.#maxNetwork = maxNetwork
    this.#maxBodyBytes = maxBodyBytes
  }

  #bucket(tabId) {
    const id = Number(tabId)
    let bucket = this.#tabs.get(id)
    if (!bucket) {
      bucket = {
        console: [],
        network: new Map(),
        nextSeq: 0,
        lastEventAt: 0,
        info: null,
        closed: false,
      }
      this.#tabs.set(id, bucket)
    }
    return bucket
  }

  get activeTabId() {
    return this.#activeTabId
  }

  setActiveTab(tabId) {
    this.#activeTabId = Number.isFinite(Number(tabId)) ? Number(tabId) : null
  }

  getTabInfo(tabId) {
    return this.#tabs.get(Number(tabId))?.info ?? null
  }

  listTabIds() {
    return [...this.#tabs.keys()]
  }

  /**
   * Apply one `event` message from the extension.
   * @param {{ tabId?: number, frameId?: number, seq?: number, ts?: number, event: string, data?: any }} event
   */
  handle(event) {
    const tabId = Number(event?.tabId)
    if (!Number.isFinite(tabId)) return
    const bucket = this.#bucket(tabId)
    bucket.lastEventAt = Date.now()
    const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : bucket.nextSeq
    bucket.nextSeq = Math.max(bucket.nextSeq, seq + 1)
    const frameId = Number.isFinite(Number(event.frameId)) ? Number(event.frameId) : 0
    const ts = Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now()
    const data = event.data ?? {}

    switch (event.event) {
      case 'console': {
        const level = CONSOLE_LEVELS.has(data.level) ? data.level : 'log'
        const text = typeof data.text === 'string' ? data.text : safeText(data.args)
        bucket.console.push({
          seq,
          ts,
          frameId,
          level,
          text,
          args: Array.isArray(data.args) ? data.args : [],
          ...(typeof data.stack === 'string' && data.stack ? { stack: data.stack } : {}),
          ...(typeof data.url === 'string' ? { url: data.url } : {}),
        })
        if (bucket.console.length > this.#maxConsole) {
          bucket.console.splice(0, bucket.console.length - this.#maxConsole)
        }
        break
      }
      case 'network.request': {
        if (!data.id) break
        const existing = bucket.network.get(data.id)
        const record = {
          id: String(data.id),
          tabId,
          frameId,
          seq,
          method: String(data.method ?? 'GET').toUpperCase(),
          url: String(data.url ?? ''),
          type: String(data.type ?? 'fetch'),
          startedAt: ts,
          ...(data.requestHeaders && typeof data.requestHeaders === 'object'
            ? { requestHeaders: data.requestHeaders }
            : {}),
          ...(typeof data.body === 'string' ? { requestBody: truncate(data.body, 4096) } : {}),
          ...(existing ? { status: existing.status, body: existing.body } : {}),
        }
        bucket.network.set(record.id, record)
        this.#trimNetwork(bucket)
        break
      }
      case 'network.response': {
        if (!data.id) break
        const record = bucket.network.get(data.id) ?? {
          id: String(data.id),
          tabId,
          frameId,
          seq,
          method: 'GET',
          url: String(data.url ?? ''),
          type: String(data.type ?? 'fetch'),
          startedAt: ts,
        }
        record.status = Number(data.status)
        if (typeof data.url === 'string' && data.url) record.url = data.url
        record.statusText = String(data.statusText ?? '')
        record.responseHeaders = data.responseHeaders ?? {}
        record.mimeType = String(data.mimeType ?? '')
        record.durationMs = Number.isFinite(Number(data.durationMs)) ? Number(data.durationMs) : undefined
        if (Number.isFinite(Number(data.size))) record.bodySize = Number(data.size)
        bucket.network.set(record.id, record)
        this.#trimNetwork(bucket)
        break
      }
      case 'network.body': {
        if (!data.id) break
        const record = bucket.network.get(data.id)
        if (!record) break
        const raw = typeof data.body === 'string' ? data.body : ''
        const size = Number.isFinite(Number(data.size)) ? Number(data.size) : raw.length
        record.bodySize = size
        record.body = truncate(raw, this.#maxBodyBytes)
        record.bodyTruncated = data.truncated === true || raw.length > this.#maxBodyBytes
        break
      }
      case 'network.error': {
        if (!data.id) break
        const record = bucket.network.get(data.id)
        if (!record) break
        record.error = String(data.message ?? 'network error')
        break
      }
      case 'tab.updated': {
        const tab = data.tab ?? data
        if (tab && typeof tab === 'object') {
          bucket.info = { ...(bucket.info ?? {}), ...tab }
          if (tab.id != null) this.#tabs.set(Number(tab.id), bucket)
        }
        break
      }
      case 'tab.removed': {
        bucket.closed = true
        break
      }
      case 'tab.activated': {
        this.setActiveTab(data.tabId ?? tabId)
        break
      }
      case 'page.lifecycle': {
        if (data.url || data.title) {
          bucket.info = { ...(bucket.info ?? {}), ...(data.url ? { url: data.url } : {}), ...(data.title ? { title: data.title } : {}) }
        }
        break
      }
      default:
        // unknown events are intentionally ignored for forward compatibility
        break
    }
  }

  #trimNetwork(bucket) {
    while (bucket.network.size > this.#maxNetwork) {
      const oldest = bucket.network.keys().next().value
      bucket.network.delete(oldest)
    }
  }

  /**
   * Read console entries for a tab.
   * @param {number} tabId
   * @param {{ level?: string, limit?: number, sinceSeq?: number }} [options]
   */
  consoleFor(tabId, { level = 'all', limit = 50, sinceSeq = 0 } = {}) {
    const bucket = this.#tabs.get(Number(tabId))
    if (!bucket) return { entries: [], total: 0, nextSeq: 0 }
    let entries = bucket.console
    if (level && level !== 'all') entries = entries.filter((entry) => entry.level === level)
    if (sinceSeq > 0) entries = entries.filter((entry) => entry.seq > sinceSeq)
    const total = entries.length
    const capped = Math.max(1, Math.min(500, Number(limit) || 50))
    const picked = entries.slice(-capped)
    return {
      entries: picked,
      total,
      nextSeq: bucket.nextSeq,
      levels: countLevels(bucket.console),
    }
  }

  clearConsole(tabId) {
    if (tabId == null) {
      for (const bucket of this.#tabs.values()) bucket.console = []
      return
    }
    const bucket = this.#tabs.get(Number(tabId))
    if (bucket) bucket.console = []
  }

  /**
   * List network requests for a tab.
   * @param {number} tabId
   * @param {{ urlContains?: string, method?: string, status?: string|number, type?: string, limit?: number, sinceSeq?: number }} [options]
   */
  networkFor(tabId, { urlContains, method, status, type, limit = 50, sinceSeq = 0 } = {}) {
    const bucket = this.#tabs.get(Number(tabId))
    if (!bucket) return { requests: [], total: 0 }
    let records = [...bucket.network.values()]
    if (urlContains) {
      const needle = String(urlContains).toLowerCase()
      records = records.filter((record) => record.url.toLowerCase().includes(needle))
    }
    if (method) {
      const wanted = String(method).toUpperCase()
      records = records.filter((record) => record.method === wanted)
    }
    if (type) records = records.filter((record) => record.type === String(type))
    if (sinceSeq > 0) records = records.filter((record) => record.seq > sinceSeq)
    if (status != null && status !== '') records = records.filter((record) => matchStatus(record, status))
    records.sort((a, b) => a.seq - b.seq)
    const total = records.length
    const capped = Math.max(1, Math.min(500, Number(limit) || 50))
    const picked = records.slice(-capped).map(toSummary)
    return { requests: picked, total }
  }

  networkGet(tabId, requestId) {
    const bucket = this.#tabs.get(Number(tabId))
    if (!bucket) return null
    const record = bucket.network.get(String(requestId))
    return record ? { ...record } : null
  }

  clearNetwork(tabId) {
    if (tabId == null) {
      for (const bucket of this.#tabs.values()) bucket.network.clear()
      return
    }
    const bucket = this.#tabs.get(Number(tabId))
    if (bucket) bucket.network.clear()
  }

  get tabCount() {
    return this.#tabs.size
  }

  stats() {
    let consoleCount = 0
    let networkCount = 0
    for (const bucket of this.#tabs.values()) {
      consoleCount += bucket.console.length
      networkCount += bucket.network.size
    }
    return { tabs: this.#tabs.size, console: consoleCount, network: networkCount }
  }
}

function countLevels(entries) {
  const levels = { log: 0, info: 0, warn: 0, error: 0, debug: 0 }
  for (const entry of entries) levels[entry.level] = (levels[entry.level] ?? 0) + 1
  return levels
}

function matchStatus(record, status) {
  if (typeof status === 'number') return record.status === status
  const text = String(status).toLowerCase()
  if (text === 'error') return record.error != null || record.status == null
  if (text === 'pending') return record.status == null && record.error == null
  if (/^[1-5]xx$/.test(text)) {
    const hundred = Number(text[0]) * 100
    return record.status != null && record.status >= hundred && record.status < hundred + 100
  }
  const numeric = Number(text)
  return Number.isFinite(numeric) ? record.status === numeric : true
}

function toSummary(record) {
  return {
    id: record.id,
    method: record.method,
    url: record.url,
    type: record.type,
    status: record.status ?? null,
    durationMs: record.durationMs ?? null,
    bodySize: record.bodySize ?? null,
    mimeType: record.mimeType ?? null,
    error: record.error ?? null,
    seq: record.seq,
  }
}

function truncate(text, max) {
  if (typeof text !== 'string') return text
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text
}

function safeText(args) {
  if (!Array.isArray(args)) return String(args ?? '')
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
}

export { CONSOLE_LEVELS }
