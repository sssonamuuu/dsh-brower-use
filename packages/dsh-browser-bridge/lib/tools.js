/**
 * Model-facing tools for the browser bridge.
 *
 * Definitions use raw JSON Schema instead of `defineTool` so this package has
 * no dependency on DSH internals (linked profile packages do not necessarily
 * resolve the host's node_modules). Every tool returns a single text block;
 * the canonical value is the same user-facing string.
 *
 * @module dsh-browser-bridge/tools
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BridgeError, ERROR } from './protocol.js'

const DEFAULT_MAX_CHARS = 30_000
const SCREENSHOT_MAX_BYTES = 12 * 1024 * 1024

/** Build a parameter schema with a compact declarative helper. */
function objectSchema(properties, required = []) {
  const props = {}
  const req = [...required]
  for (const [key, value] of Object.entries(properties)) {
    if (value && value.__required) {
      const { __required, ...rest } = value
      props[key] = rest
      if (__required && !req.includes(key)) req.push(key)
    } else {
      props[key] = value
    }
  }
  return {
    type: 'object',
    properties: props,
    additionalProperties: false,
    ...(req.length > 0 ? { required: req } : {}),
  }
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const requiredStr = (description, extra = {}) => ({ type: 'string', description, __required: true, ...extra })
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra })
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra })
const enumStr = (description, values, extra = {}) => ({ type: 'string', description, enum: values, ...extra })

/** One registry-ready tool definition. */
function browserTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const violations = validateArguments(parameters, args ?? {})
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return execute(args ?? {}, exec)
    },
  }
}

/**
 * The registry intentionally does not validate raw JSON Schema definitions, so
 * each tool validates its own arguments at the boundary. This covers the DSL
 * shapes used above (object properties, required, primitive types, enums).
 */
export function validateArguments(schema, value) {
  const violations = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['arguments must be an object']
  }
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  for (const key of required) {
    if (value[key] === undefined || value[key] === null) violations.push(`missing required argument "${key}"`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) violations.push(`unexpected argument "${key}"`)
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    const item = value[key]
    if (item === undefined) continue
    if (!matchesType(item, spec.type)) {
      violations.push(`"${key}" must be ${spec.type}`)
      continue
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(item)) {
      violations.push(`"${key}" must be one of ${spec.enum.join(', ')}`)
    }
    if (spec.type === 'integer' && !Number.isInteger(item)) {
      violations.push(`"${key}" must be an integer`)
    }
  }
  return violations
}

function matchesType(value, type) {
  if (!type) return true
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return true
}

/**
 * Register all browser tools on a host context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ bridge: import('./bridge-server.js').BridgeServer | null, getCwd: (exec: any) => Promise<string>, logger?: any }} deps
 * @returns {Array<{ name: string }>}
 */
export function registerBrowserTools(ctx, deps) {
  const runtime = new ToolRuntime(deps)
  const definitions = runtime.definitions()
  for (const definition of definitions) ctx.tools.register(definition)
  return definitions.map(({ name }) => ({ name }))
}

class ToolRuntime {
  #bridge
  #getCwd
  #logger

  constructor({ bridge, getCwd, logger }) {
    this.#bridge = bridge
    this.#getCwd = getCwd
    this.#logger = logger
  }

  #requireBridge() {
    if (!this.#bridge) {
      throw new Error('browser bridge is not started. Check the DSH host log for a bind error.')
    }
    return this.#bridge
  }

  async #activeTab(exec, tabId) {
    if (Number.isFinite(Number(tabId))) return Number(tabId)
    const stateTab = this.#bridge?.state?.activeTabId
    try {
      const result = await this.#requireBridge().command('tabs.active', {}, {
        signal: exec?.signal,
        requiredCaps: ['tabs'],
        timeoutMs: 10_000,
      })
      const id = result?.tab?.id ?? result?.id
      if (Number.isFinite(Number(id))) {
        this.#bridge?.state?.setActiveTab(Number(id))
        return Number(id)
      }
    } catch (error) {
      if (Number.isFinite(Number(stateTab))) return Number(stateTab)
      throw error
    }
    if (Number.isFinite(Number(stateTab))) return Number(stateTab)
    throw new Error('no active browser tab was found; open a normal http(s) page and try again')
  }

  async #tabMeta(exec, tabId) {
    try {
      const result = await this.#requireBridge().command('tabs.list', {}, {
        signal: exec?.signal,
        requiredCaps: ['tabs'],
        timeoutMs: 10_000,
      })
      const tab = (result?.tabs ?? []).find((item) => Number(item.id) === Number(tabId))
      if (tab) this.#bridge.state.setActiveTab(tab.id)
      return tab ?? null
    } catch {
      return null
    }
  }

  definitions() {
    return [
      this.#status(),
      this.#tabs(),
      this.#snapshot(),
      this.#read(),
      this.#screenshot(),
      this.#click(),
      this.#type(),
      this.#press(),
      this.#scroll(),
      this.#eval(),
      this.#console(),
      this.#network(),
      this.#wait(),
    ]
  }

  #status() {
    return browserTool(
      'browser_status',
      'Check the DSH Browser Bridge: whether the browser extension is connected and which browser it is. Call this first when any browser_* tool reports that no extension is connected. Extensions auto-pair when loaded; a pairing code remains only as a manual fallback.',
      objectSchema({}),
      async () => {
        if (!this.#bridge) {
          return [
            'DSH Browser Bridge: not running.',
            'The host plugin could not bind a local port. Check the DSH host log for "[browser-bridge]".',
          ].join('\n')
        }
        const status = this.#bridge.status()
        const lines = [
          `DSH Browser Bridge v${status.version} (protocol ${status.protocol})`,
          `Bridge: ${status.listening ? `listening on http://${status.host}:${status.port}` : 'NOT listening'}${status.error ? ` — ${status.error}` : ''}`,
          `Extension: ${status.paired ? `connected (${status.clients.length} browser${status.clients.length === 1 ? '' : 's'})` : 'NOT connected'}`,
        ]
        for (const client of status.clients) {
          lines.push(
            `  - ${client.brand} ${client.browserVersion} (${client.browser}) · extension ${client.extensionVersion} · ${client.platform}`,
          )
          lines.push(`    caps: ${client.caps.join(', ')}`)
        }
        lines.push(`Auto-pair: ${status.autoPair === false ? 'disabled (manual pairing required)' : 'enabled'}`)
        if (status.autoPair === false) {
          lines.push(`Manual pairing code: ${status.pairingCode}`)
        }
        if (!status.paired) {
          lines.push(
            'To connect: load the DSH Browser Bridge extension from this repository\'s extension/ directory (chrome://extensions → Developer mode → Load unpacked), then click its toolbar icon.',
            status.autoPair === false
              ? 'Enter the manual pairing code above and click Pair.'
              : 'It should connect automatically within a few seconds. If it does not, open the extension options and use the manual pairing code shown by browser_status.',
          )
        } else {
          const probe = await this.#probeExtension()
          if (probe === 'ok') {
            lines.push('The extension is ready. Use browser_tabs to see open tabs.')
          } else if (probe === 'unresponsive') {
            lines.push(
              'The extension socket is open but it is NOT answering commands (its chrome.* API is stuck).',
              'Fix: open edge://extensions (or chrome://extensions) and reload the DSH Browser Bridge extension, then call browser_status again.',
              'Events already collected stay readable through browser_console / browser_network meanwhile.',
            )
          } else if (probe === 'timeout') {
            lines.push(
              'The extension did not answer a no-op ping in time; it may be reloading or the browser is busy.',
              'If this repeats, reload the extension at edge://extensions.',
            )
          } else {
            lines.push('The extension is ready. (Its version does not support the liveness probe; this is expected for extension builds before 0.1.1.)')
          }
        }
        const stats = status.stats
        lines.push(`Buffers: ${stats.tabs} tab(s), ${stats.console} console entry(ies), ${stats.network} network request(s)`)
        lines.push(`Token file: ${status.stateFile}`)
        return lines.join('\n')
      },
    )
  }

  /**
   * Liveness probe that deliberately avoids chrome.* APIs on the extension
   * side, so a hung `chrome.tabs` cannot masquerade as a missing extension.
   * @returns {Promise<'ok'|'unresponsive'|'timeout'|'unsupported'>}
   */
  async #probeExtension() {
    try {
      await this.#bridge.command('system.ping', {}, { timeoutMs: 4000 })
      return 'ok'
    } catch (error) {
      if (error?.code === 'CAPABILITY_MISSING') return 'unsupported'
      if (error?.code === 'UNKNOWN_ACTION' || error?.code === 'UNSUPPORTED_ACTION') return 'unsupported'
      if (error?.code === 'TIMEOUT') {
        // A live worker answers in milliseconds; a socket that never replies to
        // a no-op is the stuck-worker signature, not ordinary slowness.
        return 'unresponsive'
      }
      if (error?.code === 'NO_CLIENT') return 'ok'
      return 'unsupported'
    }
  }

  #tabs() {
    return browserTool(
      'browser_tabs',
      'List or control the user\'s real browser tabs (Chrome/Edge). Actions: list (default), activate, open, close, reload, back, forward. Use "list" before acting when you need a tab id. Prefer an existing tab; when a new page is needed, action=open creates a tab in the user\'s existing browser window with their cookies and login state, not a separate unauthenticated browser. Use this for web lookups when the extension is connected.',
      objectSchema(
        {
          action: enumStr('Operation to perform. Defaults to list.', ['list', 'activate', 'open', 'close', 'reload', 'back', 'forward']),
          tabId: int('Target tab id. Required for activate/close/reload/back/forward.'),
          url: str('URL to open for action=open. Must be http(s).'),
          active: bool('For open: focus the new tab (default true).'),
          bypassCache: bool('For reload: bypass the HTTP cache.'),
          browser: str('Optional browser brand filter/selection, e.g. Edge or Chrome. Defaults to the most recently connected browser.'),
          limit: int('Maximum tabs to list (default 50).'),
        },
        [],
      ),
      async (args, exec) => {
        const action = args.action ?? 'list'
        const bridge = this.#requireBridge()
        switch (action) {
          case 'list': {
            const data = await bridge.listTabs({ signal: exec?.signal, timeoutMs: 10_000, browser: args.browser })
            const tabs = (data?.tabs ?? []).slice(0, clamp(args.limit, 1, 200, 50))
            if (tabs.length === 0) return 'No controllable tabs found. Open an http(s) page and try again.'
            const active = tabs.find((tab) => tab.active)
            if (active) bridge.state.setActiveTab(active.id)
            const groups = new Map()
            for (const tab of tabs) {
              const key = tab.browser || 'Browser'
              if (!groups.has(key)) groups.set(key, [])
              groups.get(key).push(tab)
            }
            const lines = [`Tabs (${data?.tabs?.length ?? tabs.length} total across ${groups.size} browser(s)):`]
            for (const [browser, items] of groups) {
              lines.push(`[${browser}]`)
              for (const tab of items) {
                const flags = [tab.active ? 'ACTIVE' : null, tab.pinned ? 'pinned' : null, tab.discarded ? 'discarded' : null].filter(Boolean).join(',')
                lines.push(`  ${flags ? `[${flags}] ` : ''}id=${tab.id} win=${tab.windowId} "${clip(tab.title ?? '', 80)}" ${tab.url ?? ''}`)
              }
            }
            if (data?.errors?.length) {
              lines.push(`Warnings: ${data.errors.map((error) => `${error.browser}: ${error.message}`).join('; ')}`)
            }
            return lines.join('\n')
          }
          case 'activate': {
            const tabId = requireTabId(args)
            const data = await bridge.command('tabs.activate', { tabId }, { tabId, browser: args.browser, signal: exec?.signal, requiredCaps: ['tabs'], timeoutMs: 10_000 })
            bridge.state.setActiveTab(tabId)
            const tab = data?.tab ?? {}
            return `Activated tab ${tabId}: "${clip(tab.title ?? '', 120)}" ${tab.url ?? ''}`
          }
          case 'open': {
            if (!args.url) throw new Error('browser_tabs action=open requires a url')
            const data = await bridge.command('tabs.open', { url: args.url, active: args.active !== false }, {
              browser: args.browser,
              signal: exec?.signal,
              requiredCaps: ['tabs'],
              timeoutMs: 15_000,
            })
            const tab = data?.tab ?? {}
            if (tab.id != null) bridge.state.setActiveTab(tab.id)
            return `Opened tab ${tab.id ?? '?'}: "${clip(tab.title ?? '', 120)}" ${tab.url ?? args.url}`
          }
          case 'close': {
            const tabId = requireTabId(args)
            await bridge.command('tabs.close', { tabId }, { tabId, browser: args.browser, signal: exec?.signal, requiredCaps: ['tabs'], timeoutMs: 10_000 })
            return `Closed tab ${tabId}.`
          }
          case 'reload': {
            const tabId = requireTabId(args)
            await bridge.command('tabs.reload', { tabId, bypassCache: args.bypassCache === true }, {
              tabId,
              browser: args.browser,
              signal: exec?.signal,
              requiredCaps: ['tabs'],
              timeoutMs: 10_000,
            })
            return `Reloaded tab ${tabId}${args.bypassCache ? ' (bypassing cache)' : ''}.`
          }
          case 'back':
          case 'forward': {
            const tabId = requireTabId(args)
            await bridge.command(`tabs.${action}`, { tabId }, { tabId, browser: args.browser, signal: exec?.signal, requiredCaps: ['tabs'], timeoutMs: 10_000 })
            return `${action === 'back' ? 'Went back' : 'Went forward'} in tab ${tabId}.`
          }
          default:
            throw new Error(`unknown browser_tabs action "${action}"`)
        }
      },
    )
  }

  #snapshot() {
    return browserTool(
      'browser_snapshot',
      'Return the current page title/URL, viewport and scroll position, a list of visible interactive elements with stable `ref` values, and (optionally) the page text. Use the returned ref with browser_click / browser_type. Call this before interacting with a page you have not inspected. Refs expire after a navigation, so snapshot again after the page changes.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          maxChars: int('Maximum characters of the whole result (default 30000).'),
          includeText: bool('Include the visible page text (default true).'),
          selector: str('Optional CSS selector to scope the snapshot.'),
        },
        [],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const data = await this.#requireBridge().command('page.snapshot', {
          maxChars: clamp(args.maxChars, 2000, 120_000, DEFAULT_MAX_CHARS),
          includeText: args.includeText !== false,
          ...(args.selector ? { selector: args.selector } : {}),
        }, { tabId, signal: exec?.signal, requiredCaps: ['dom'], timeoutMs: 25_000 })
        return formatSnapshot(data, clamp(args.maxChars, 2000, 120_000, DEFAULT_MAX_CHARS))
      },
    )
  }

  #read() {
    return browserTool(
      'browser_read',
      'Read the readable text (innerText) of a page or of one CSS selector. Use this when you need article/content text rather than interactive structure. For debugging UI state, browser_snapshot is usually better.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          selector: str('CSS selector. Defaults to document.body.'),
          maxChars: int('Maximum characters (default 30000).'),
        },
        [],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const maxChars = clamp(args.maxChars, 500, 120_000, DEFAULT_MAX_CHARS)
        const data = await this.#requireBridge().command('page.read', {
          selector: args.selector ?? 'body',
          maxChars,
        }, { tabId, signal: exec?.signal, requiredCaps: ['dom'], timeoutMs: 20_000 })
        return [
          `Page: ${data?.title ?? ''} — ${data?.url ?? ''}`,
          data?.truncated ? '[text truncated]' : null,
          '',
          clip(data?.text ?? '', maxChars),
        ].filter((line) => line !== null).join('\n')
      },
    )
  }

  #screenshot() {
    return browserTool(
      'browser_screenshot',
      'Capture the visible viewport of a tab and save it as a PNG file. Returns the absolute file path; call read_image on that path to view it. captureVisibleTab only captures the visible viewport, so scroll first if you need content below the fold. May briefly focus the target tab/window.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          format: enumStr('Image format (default png).', ['png', 'jpeg']),
          quality: int('JPEG quality 1-100 (ignored for png).'),
        },
        [],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const format = args.format === 'jpeg' ? 'jpeg' : 'png'
        const data = await this.#requireBridge().command('page.screenshot', {
          format,
          ...(format === 'jpeg' ? { quality: clamp(args.quality, 1, 100, 80) } : {}),
        }, { tabId, signal: exec?.signal, requiredCaps: ['screenshot'], timeoutMs: 20_000 })
        const dataUrl = String(data?.dataUrl ?? '')
        const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl)
        if (!match) throw new Error('screenshot returned an unexpected data URL')
        const buffer = Buffer.from(match[2], 'base64')
        if (buffer.length > SCREENSHOT_MAX_BYTES) throw new Error(`screenshot is too large (${buffer.length} bytes)`)
        const cwd = await this.#getCwd(exec)
        const dir = path.join(cwd, '.dsh-browser', 'screenshots')
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, `shot-${Date.now()}-tab${tabId}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`)
        await writeFile(file, buffer)
        const size = imageSize(buffer, match[1])
        return [
          `Screenshot saved: ${file}`,
          `Tab: ${tabId} · ${size.width || data?.width || '?'}x${size.height || data?.height || '?'} · ${formatLabel(buffer.length)}`,
          'Use read_image with this path to view the image.',
        ].join('\n')
      },
    )
  }

  #click() {
    return browserTool(
      'browser_click',
      'Click an element in the page. Target it with a snapshot `ref` (preferred), a CSS selector, visible text, or viewport coordinates. Uses a DOM click; most React/Vue handlers work, but the event is not a trusted browser input event. Returns the clicked element description and the resulting URL.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          ref: str('Element ref from browser_snapshot, e.g. "e12".'),
          selector: str('CSS selector for the element.'),
          text: str('Visible text to match (exact first, then substring).'),
          x: int('Viewport X coordinate (requires y).'),
          y: int('Viewport Y coordinate (requires x).'),
          button: enumStr('Mouse button (default left).', ['left', 'right', 'middle']),
          clickCount: int('Number of clicks (default 1; use 2 for double click).'),
          waitMs: int('Wait after clicking before returning (default 150).'),
        },
        [],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const target = pickTarget(args)
        const data = await this.#requireBridge().command('page.click', {
          ...target,
          button: args.button ?? 'left',
          clickCount: clamp(args.clickCount, 1, 3, 1),
          waitMs: clamp(args.waitMs, 0, 10_000, 150),
        }, { tabId, signal: exec?.signal, requiredCaps: ['input'], timeoutMs: 20_000 })
        return [
          `Clicked ${data?.tag ?? 'element'}${data?.name ? ` "${clip(data.name, 120)}"` : ''}${data?.ref ? ` [${data.ref}]` : ''}.`,
          data?.url ? `Page URL: ${data.url}` : null,
        ].filter(Boolean).join('\n')
      },
    )
  }

  #type() {
    return browserTool(
      'browser_type',
      'Type text into an input, textarea, select or contenteditable element. Target with a snapshot `ref` (preferred), a CSS selector, or an element matching visible text. Uses the native value setter and dispatches input/change events, so React/Vue controlled inputs update. Set submit=true to press Enter afterwards.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          ref: str('Element ref from browser_snapshot.'),
          selector: str('CSS selector for the field.'),
          text: str('Visible text to locate the field.'),
          value: requiredStr('Text to enter. Use an empty string together with clear=true to clear a field.'),
          clear: bool('Clear the field first (default true).'),
          submit: bool('Press Enter after typing (default false).'),
          delayMs: int('Delay between keystrokes; 0 sets the value at once (default 0).'),
        },
        ['value'],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const target = pickTarget(args)
        const data = await this.#requireBridge().command('page.type', {
          ...target,
          value: String(args.value),
          clear: args.clear !== false,
          submit: args.submit === true,
          delayMs: clamp(args.delayMs, 0, 5000, 0),
        }, { tabId, signal: exec?.signal, requiredCaps: ['input'], timeoutMs: 25_000 })
        return [
          `Typed ${String(args.value).length} character(s) into ${data?.tag ?? 'field'}${data?.name ? ` "${clip(data.name, 100)}"` : ''}${data?.ref ? ` [${data.ref}]` : ''}.`,
          data?.submitted ? 'Pressed Enter after typing.' : null,
        ].filter(Boolean).join('\n')
      },
    )
  }

  #press() {
    return browserTool(
      'browser_press',
      'Press a key or key combination on the focused element or on a target element. Examples: "Enter", "Escape", "Tab", "Meta+A", "Control+Shift+R". Key names follow KeyboardEvent.key (single characters or names like ArrowDown).',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          key: requiredStr('Key name, optionally combined with modifiers using "+", e.g. "Meta+A".'),
          ref: str('Optional element ref to focus before pressing.'),
          selector: str('Optional CSS selector to focus before pressing.'),
        },
        ['key'],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const data = await this.#requireBridge().command('page.press', {
          key: String(args.key),
          ...(args.ref ? { ref: args.ref } : {}),
          ...(args.selector ? { selector: args.selector } : {}),
        }, { tabId, signal: exec?.signal, requiredCaps: ['input'], timeoutMs: 15_000 })
        return `Pressed "${args.key}"${data?.target ? ` on ${data.target}` : ''}.`
      },
    )
  }

  #scroll() {
    return browserTool(
      'browser_scroll',
      'Scroll the page or a scrollable element. Useful before browser_screenshot (which only captures the visible viewport) or to load lazy content.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          direction: enumStr('Scroll direction (default down).', ['up', 'down', 'left', 'right', 'top', 'bottom']),
          amount: int('Pixels to scroll for up/down/left/right (default one viewport).'),
          ref: str('Optional element ref to scroll inside.'),
          selector: str('Optional CSS selector to scroll inside.'),
        },
        [],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const data = await this.#requireBridge().command('page.scroll', {
          direction: args.direction ?? 'down',
          ...(args.amount != null ? { amount: clamp(args.amount, 1, 100_000, 800) } : {}),
          ...(args.ref ? { ref: args.ref } : {}),
          ...(args.selector ? { selector: args.selector } : {}),
        }, { tabId, signal: exec?.signal, requiredCaps: ['input'], timeoutMs: 15_000 })
        return `Scrolled to x=${Math.round(data?.scrollX ?? 0)}, y=${Math.round(data?.scrollY ?? 0)} (page height ${Math.round(data?.scrollHeight ?? 0)}).`
      },
    )
  }

  #eval() {
    return browserTool(
      'browser_eval',
      'Evaluate JavaScript in the page MAIN world and return a JSON-safe result. Supports expressions ("document.title") and statements ("const x = 1; return x") when wrapped in an async function. This is powerful: only run code the user asked for or that is clearly needed for debugging. Page CSP may block eval; if you see CSP_BLOCKED, fall back to DOM tools.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          expression: requiredStr('JavaScript expression or statements. Prefer a single expression.'),
          awaitPromise: bool('Await a returned Promise (default true).'),
        },
        ['expression'],
      ),
      async (args, exec) => {
        const tabId = await this.#activeTab(exec, args.tabId)
        const data = await this.#requireBridge().command('page.eval', {
          expression: String(args.expression),
          awaitPromise: args.awaitPromise !== false,
        }, { tabId, signal: exec?.signal, requiredCaps: ['dom'], timeoutMs: 35_000 })
        const value = data?.value
        const type = data?.type ?? typeof value
        if (data?.truncated) return `Result (${type}, truncated):\n${clip(data.value, 20_000)}`
        if (typeof value === 'string') return `Result (${type}):\n${clip(value, 20_000)}`
        return `Result (${type}):\n${JSON.stringify(value, null, 2) ?? String(value)}`
      },
    )
  }

  #console() {
    return browserTool(
      'browser_console',
      'Read console/error entries captured from the page after the extension was injected. Includes console.log/info/warn/error/debug, uncaught exceptions and unhandled promise rejections. Entries are buffered on the host, so this works even if the page has navigated. Use sinceSeq for incremental reads. Set clear=true to clear the host-side buffer (it does not clear DevTools).',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          level: enumStr('Filter by level (default all).', ['all', 'error', 'warn', 'info', 'log', 'debug']),
          limit: int('Maximum entries to return, newest last (default 50).'),
          sinceSeq: int('Only entries with seq greater than this value.'),
          clear: bool('Clear the host-side buffer after reading.'),
        },
        [],
      ),
      async (args, exec) => {
        const bridge = this.#requireBridge()
        const tabId = await this.#activeTab(exec, args.tabId)
        const data = bridge.state.consoleFor(tabId, {
          level: args.level ?? 'all',
          limit: clamp(args.limit, 1, 500, 50),
          sinceSeq: Math.max(0, Number(args.sinceSeq) || 0),
        })
        const lines = [
          `Console for tab ${tabId}: ${data.entries.length} shown of ${data.total} matched (nextSeq ${data.nextSeq}).`,
          `All levels: log ${data.levels?.log ?? 0}, info ${data.levels?.info ?? 0}, warn ${data.levels?.warn ?? 0}, error ${data.levels?.error ?? 0}, debug ${data.levels?.debug ?? 0}.`,
        ]
        if (data.entries.length === 0) {
          lines.push(
            'No matching entries. The collector only sees events that happened after it was injected; reload the page to capture startup errors.',
          )
        } else {
          lines.push('')
          for (const entry of data.entries) {
            const time = new Date(entry.ts).toISOString().slice(11, 23)
            const level = entry.level.toUpperCase().padEnd(5)
            lines.push(`[${entry.seq}] ${time} ${level} ${clip(entry.text, 4000)}`)
            if (entry.stack) lines.push(indent(clip(entry.stack, 3000), '    '))
          }
        }
        if (args.clear) {
          bridge.state.clearConsole(tabId)
          lines.push('', '(Host-side console buffer cleared.)')
        }
        return lines.join('\n')
      },
    )
  }

  #network() {
    return browserTool(
      'browser_network',
      'Inspect fetch/XHR activity captured from the page. action=list returns request summaries (method, URL, status, duration, size, errors); action=get returns request/response headers, timing and the text/JSON response body; action=clear clears the host-side buffer. Bodies are capped at 256KB and binary responses are not read. Use urlContains/status filters to find the failing request.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          action: enumStr('Operation (default list).', ['list', 'get', 'clear']),
          requestId: str('Request id for action=get.'),
          urlContains: str('Case-insensitive URL substring filter.'),
          method: str('HTTP method filter, e.g. GET, POST.'),
          status: str('Status filter: exact number, "error", "pending", or "4xx"/"5xx".'),
          type: str('Request type filter: fetch or xhr.'),
          limit: int('Maximum requests to list (default 50).'),
          includeBody: bool('For action=get, include the response body (default true).'),
          clear: bool('For action=list, clear the buffer after reading.'),
        },
        [],
      ),
      async (args, exec) => {
        const bridge = this.#requireBridge()
        const action = args.action ?? 'list'
        const tabId = await this.#activeTab(exec, args.tabId)
        if (action === 'clear') {
          bridge.state.clearNetwork(tabId)
          return `Cleared the host-side network buffer for tab ${tabId}.`
        }
        if (action === 'get') {
          if (!args.requestId) throw new Error('browser_network action=get requires requestId')
          const record = bridge.state.networkGet(tabId, args.requestId)
          if (!record) {
            throw new Error(`no captured request "${args.requestId}" for tab ${tabId}. It may predate the collector, or the tab navigated; call browser_network action=list first.`)
          }
          return formatNetworkDetail(record, args.includeBody !== false)
        }
        const data = bridge.state.networkFor(tabId, {
          ...(args.urlContains ? { urlContains: args.urlContains } : {}),
          ...(args.method ? { method: args.method } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.type ? { type: args.type } : {}),
          limit: clamp(args.limit, 1, 500, 50),
        })
        const lines = [`Network for tab ${tabId}: ${data.requests.length} shown of ${data.total} matched.`]
        if (data.requests.length === 0) {
          lines.push(
            'No matching requests. The collector only sees fetch/XHR calls made after it was injected; reload the page to capture startup requests. WebSocket and server-sent events are not covered.',
          )
        } else {
          lines.push('')
          for (const request of data.requests) {
            const status = request.error ? `ERR ${request.error}` : request.status ?? 'pending'
            const size = request.bodySize != null ? formatLabel(request.bodySize) : '?'
            const duration = request.durationMs != null ? `${Math.round(request.durationMs)}ms` : '?'
            lines.push(`[${request.id}] ${request.method} ${clip(request.url, 500)} → ${status} · ${duration} · ${size} · ${request.type}`)
          }
          lines.push('', 'Use browser_network {action:"get", requestId:"…"} for headers and the response body.')
        }
        if (args.clear) {
          bridge.state.clearNetwork(tabId)
          lines.push('', '(Host-side network buffer cleared.)')
        }
        return lines.join('\n')
      },
    )
  }

  #wait() {
    return browserTool(
      'browser_wait',
      'Wait until a condition becomes true, bounded by timeoutMs. Conditions: selector (CSS selector appears), text (visible text appears), console_error (a new error/warn-level console entry appears), network_idle (no new fetch/XHR for a short quiet period). Use after clicking or typing when the page updates asynchronously.',
      objectSchema(
        {
          tabId: int('Tab id. Defaults to the active tab.'),
          for: enumStr('Condition to wait for.', ['selector', 'text', 'console_error', 'network_idle']),
          value: str('Selector or text for selector/text conditions.'),
          timeoutMs: int('Maximum wait in milliseconds (default 10000, max 120000).'),
          pollMs: int('Polling interval for host-side conditions (default 250).'),
        },
        ['for'],
      ),
      async (args, exec) => {
        const condition = args.for
        const timeoutMs = clamp(args.timeoutMs, 100, 120_000, 10_000)
        if (condition === 'selector' || condition === 'text') {
          if (!args.value) throw new Error(`browser_wait for=${condition} requires a value`)
          const tabId = await this.#activeTab(exec, args.tabId)
          const data = await this.#requireBridge().command('page.wait', {
            for: condition,
            value: String(args.value),
            timeoutMs,
            pollMs: clamp(args.pollMs, 50, 2000, 200),
          }, { tabId, signal: exec?.signal, requiredCaps: ['dom'], timeoutMs: timeoutMs + 10_000 })
          return `Matched ${condition} "${args.value}"${data?.ref ? ` as [${data.ref}]` : ''} after ${Math.round(data?.elapsedMs ?? 0)}ms.`
        }
        const bridge = this.#requireBridge()
        const tabId = await this.#activeTab(exec, args.tabId)
        const started = Date.now()
        if (condition === 'console_error') {
          const initial = bridge.state.consoleFor(tabId, { level: 'all', limit: 1 })
          const since = initial.nextSeq
          while (Date.now() - started < timeoutMs) {
            const data = bridge.state.consoleFor(tabId, { level: 'all', limit: 100, sinceSeq: since })
            const found = data.entries.find((entry) => entry.level === 'error' || entry.level === 'warn')
            if (found) {
              return `New ${found.level} entry after ${Date.now() - started}ms:\n${clip(found.text, 4000)}${found.stack ? `\n${clip(found.stack, 2000)}` : ''}`
            }
            await sleep(Math.max(50, Number(args.pollMs) || 250), exec?.signal)
          }
          throw new Error(`no new console error/warn within ${timeoutMs}ms`)
        }
        if (condition === 'network_idle') {
          const initial = bridge.state.networkFor(tabId, { limit: 1 })
          const initialTotal = initial.total
          let quietSince = Date.now()
          while (Date.now() - started < timeoutMs) {
            const data = bridge.state.networkFor(tabId, { limit: 500 })
            const pending = data.requests.filter((request) => request.status == null && request.error == null)
            if (data.total > initialTotal) {
              quietSince = Date.now()
            }
            if (pending.length === 0 && Date.now() - quietSince >= 800) {
              return `Network idle after ${Date.now() - started}ms (${data.total - initialTotal} new request(s), none pending).`
            }
            await sleep(Math.max(50, Number(args.pollMs) || 250), exec?.signal)
          }
          throw new Error(`network did not become idle within ${timeoutMs}ms`)
        }
        throw new Error(`unknown browser_wait condition "${condition}"`)
      },
    )
  }
}

function requireTabId(args) {
  if (!Number.isFinite(Number(args.tabId))) throw new Error('this action requires a tabId (use browser_tabs action=list first)')
  return Number(args.tabId)
}

function pickTarget(args) {
  const targets = []
  if (args.ref) targets.push({ ref: String(args.ref) })
  if (args.selector) targets.push({ selector: String(args.selector) })
  if (args.text) targets.push({ text: String(args.text) })
  if (args.x != null && args.y != null) targets.push({ x: Number(args.x), y: Number(args.y) })
  if (targets.length === 0) throw new Error('specify one of ref, selector, text, or x+y as the target')
  if (targets.length > 1) throw new Error('specify exactly one target: ref, selector, text, or x+y')
  return targets[0]
}

function formatSnapshot(data, maxChars) {
  const lines = []
  lines.push(`Page: ${data?.title ?? ''} — ${data?.url ?? ''}`)
  const viewport = data?.viewport ?? {}
  const scroll = data?.scroll ?? {}
  lines.push(
    `Viewport: ${viewport.width ?? '?'}x${viewport.height ?? '?'} @${viewport.devicePixelRatio ?? 1}x | scroll: x=${Math.round(scroll.x ?? 0)} y=${Math.round(scroll.y ?? 0)} of ${Math.round(scroll.maxY ?? 0)}`,
  )
  const interactive = Array.isArray(data?.interactive) ? data.interactive : []
  lines.push(`Interactive elements (${data?.interactiveTotal ?? interactive.length}):`)
  for (const item of interactive) {
    const bits = [`[${item.ref}]`, item.role ?? item.tag ?? 'element']
    if (item.name) bits.push(`"${clip(item.name, 120)}"`)
    if (item.type) bits.push(`type=${item.type}`)
    if (item.value != null && item.value !== '') bits.push(`value=${JSON.stringify(clip(String(item.value), 200))}`)
    if (item.checked) bits.push('checked')
    if (item.disabled) bits.push('disabled')
    if (item.href) bits.push(`href=${clip(item.href, 200)}`)
    if (item.selector) bits.push(`@ ${clip(item.selector, 160)}`)
    lines.push(`  ${bits.join(' · ')}`)
  }
  if (data?.text) {
    lines.push('', 'Page text (visible):', clip(data.text, Math.max(1000, maxChars - lines.join('\n').length - 50)))
  }
  lines.push(data?.truncated ? '' : '', data?.truncated ? '[snapshot truncated]' : null)
  return clip(lines.filter((line) => line != null).join('\n'), maxChars)
}

function formatNetworkDetail(record, includeBody) {
  const lines = [
    `${record.method} ${record.url}`,
    `Type: ${record.type} · Status: ${record.status ?? 'pending'} ${record.statusText ?? ''}${record.error ? ` · error: ${record.error}` : ''}`,
    `Duration: ${record.durationMs != null ? `${Math.round(record.durationMs)}ms` : 'unknown'} · Body size: ${record.bodySize != null ? formatLabel(record.bodySize) : 'unknown'} · seq ${record.seq}`,
  ]
  if (record.requestHeaders && Object.keys(record.requestHeaders).length > 0) {
    lines.push('', 'Request headers:', ...Object.entries(record.requestHeaders).slice(0, 50).map(([key, value]) => `  ${key}: ${clip(String(value), 1000)}`))
  }
  if (record.requestBody) lines.push('', 'Request body:', clip(record.requestBody, 4000))
  if (record.responseHeaders && Object.keys(record.responseHeaders).length > 0) {
    lines.push('', 'Response headers:', ...Object.entries(record.responseHeaders).slice(0, 50).map(([key, value]) => `  ${key}: ${clip(String(value), 1000)}`))
  }
  if (includeBody) {
    if (record.body) {
      lines.push('', `Response body${record.bodyTruncated ? ' (truncated)' : ''}:`, clip(record.body, 24_000))
    } else {
      lines.push('', 'Response body: not captured (binary, empty, streamed, or still loading).')
    }
  }
  return lines.join('\n')
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]` : value
}

function indent(text, prefix) {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n')
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function formatLabel(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeError(ERROR.ABORTED, 'wait aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BridgeError(ERROR.ABORTED, 'wait aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function imageSize(buffer, format) {
  if (format === 'png' && buffer.length >= 24 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (format === 'jpeg' && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return {}
}

/** Text inserted into the system prompt so models know the tool family exists. */
export const SYSTEM_PROMPT = [
  'The browser_* tools operate the user\'s real Chrome/Edge tabs, including logged-in pages. When browser_status reports a connected extension, use browser_tabs for every web search/page lookup: reuse a matching existing tab, or use action=open with the target/search URL to open a tab in the user\'s existing browser window. Do not use web_search/web_fetch or launch a separate unauthenticated browser; those sessions do not carry the user\'s cookies, login state, or local network access. Only fall back to web_search/web_fetch when the extension is unavailable or the user explicitly asks for a server-side fetch.',
  'Call browser_status first if tool calls report that the extension is not connected.',
  'Before clicking or typing on an unfamiliar page, call browser_snapshot and use the returned ref; refs expire after navigation.',
  'For frontend debugging, browser_console and browser_network show only events captured after the @-selected page was attached through chrome.debugger; they are not retroactive. browser_screenshot saves a PNG path; use read_image to view it.',
  'Never run destructive JavaScript through browser_eval unless the user explicitly asks for it.',
].join(' ')

export { ToolRuntime }
