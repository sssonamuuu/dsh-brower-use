/**
 * DSH host plugin: exposes browser_* tools backed by the local bridge and the
 * user's Chrome/Edge extension.
 *
 * @module dsh-browser-bridge
 */
import { BridgeServer } from './bridge-server.js'
import { registerBrowserTools, SYSTEM_PROMPT } from './tools.js'
import { DEFAULT_PORT, DEFAULT_PORT_RANGE, PACKAGE_VERSION } from './protocol.js'

export const name = 'browser-bridge'
/** Services the plugin needs. workingDirectory/systemPrompt are optional lookups. */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  const bridge = new BridgeServer({
    ...config,
    logger,
  })
  let startError = null
  try {
    await bridge.start()
  } catch (error) {
    startError = error
    logger?.error?.(`[browser-bridge] failed to start: ${error.message}`)
  }

  const getCwd = async (exec) => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory?.ensure && exec?.agent) {
        const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
        if (typeof cwd === 'string' && cwd) return cwd
      }
    } catch {
      // fall through to the host process cwd
    }
    return process.cwd()
  }

  const tools = registerBrowserTools(ctx, { bridge, getCwd, logger })
  logger?.info?.(`[browser-bridge] registered ${tools.length} browser tools (v${PACKAGE_VERSION})`)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt?.section) {
    ctx.effect(
      () => systemPrompt.section({
        name: 'tool:browser',
        order: 450,
        text: SYSTEM_PROMPT,
      }),
      'browser-bridge.systemPrompt',
    )
  }


  // Serve the open-tab list to the Web @ menu. The client source lives in
  // lib/client.js and fetches this same-origin route, so no sensitive tab data
  // crosses an unauthenticated cross-origin boundary.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/browser-bridge/client-status',
      resource: async (request) => {
        const origin = request.headers.get('origin')
        const host = request.headers.get('host')
        if (origin && origin !== `http://${host}` && origin !== `https://${host}` && origin !== 'null') {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403)
        }
        const clientModules = webCtx.get('clientModules') ?? ctx.get('clientModules')
        let clientPath = null
        let error = null
        try {
          clientPath = clientModules?.clientPath?.('@sssonamuuu/dsh-browser-bridge') ?? null
        } catch (problem) {
          error = problem instanceof Error ? problem.message : String(problem)
        }
        return jsonResponse({ ok: true, hasService: Boolean(clientModules), clientPath, error })
      },
    }), 'browser-bridge: client status route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/browser-bridge/tabs',
      resource: async (request) => {
        const origin = request.headers.get('origin')
        const host = request.headers.get('host')
        const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
        if (origin && !sameOrigin && origin !== 'null') {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403)
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' })
        }
        try {
          const data = await bridge.listTabs({ timeoutMs: 5000 })
          const browser = data.clients.length === 1
            ? { brand: data.clients[0].brand, engine: data.clients[0].browser, version: data.clients[0].browserVersion }
            : null
          return jsonResponse({ ok: true, browser, browsers: data.clients, tabs: data.tabs, errors: data.errors }, 200)
        } catch (error) {
          const code = error?.code ?? 'NO_CLIENT'
          return jsonResponse(
            { ok: false, error: code, message: error instanceof Error ? error.message : String(error), tabs: [] },
            code === 'NO_CLIENT' ? 503 : 500,
          )
        }
      },
    }), 'browser-bridge: @ tabs route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/browser-bridge/arm',
      // The webserver only dispatches GET/HEAD to `resource`; this route has a
      // side effect and uses a POST body, so it must own the raw handler.
      handler: async (req, res) => {
        const origin = req.headers.origin
        const host = req.headers.host
        const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
        if (origin && !sameOrigin && origin !== 'null') {
          writeJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 8 * 1024) throw new Error('too large')
          }
        } catch {
          writeJson(res, 413, { ok: false, error: 'payload_too_large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          writeJson(res, 400, { ok: false, error: 'bad_request' })
          return
        }
        const tabId = Number(payload?.tabId)
        if (!Number.isFinite(tabId)) {
          writeJson(res, 400, { ok: false, error: 'bad_request', message: 'tabId is required' })
          return
        }
        try {
          const data = await bridge.command('collector.ensure', { tabId }, {
            tabId,
            timeoutMs: 5000,
            requiredCaps: ['dom'],
          })
          writeJson(res, 200, { ok: true, ...data })
        } catch (error) {
          writeJson(res, error?.code === 'NO_CLIENT' ? 503 : 400, {
            ok: false,
            error: error?.code ?? 'ARM_FAILED',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'browser-bridge: arm route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/browser-bridge/activate',
      // Same shape as `arm`: side effect plus POST body, so it owns the raw
      // handler instead of the GET/HEAD `resource` path.
      handler: async (req, res) => {
        const origin = req.headers.origin
        const host = req.headers.host
        const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
        if (origin && !sameOrigin && origin !== 'null') {
          writeJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 8 * 1024) throw new Error('too large')
          }
        } catch {
          writeJson(res, 413, { ok: false, error: 'payload_too_large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          writeJson(res, 400, { ok: false, error: 'bad_request' })
          return
        }
        const tabId = Number(payload?.tabId)
        if (!Number.isFinite(tabId)) {
          writeJson(res, 400, { ok: false, error: 'bad_request', message: 'tabId is required' })
          return
        }
        try {
          // Focusing a tab is local and cheap; the extension routes it to
          // whichever browser owns that id.
          const data = await bridge.command('tabs.activate', { tabId }, {
            tabId,
            timeoutMs: 10_000,
            requiredCaps: ['tabs'],
          })
          writeJson(res, 200, { ok: true, tabId, tab: data?.tab ?? null })
        } catch (error) {
          const code = error?.code ?? 'ACTIVATE_FAILED'
          writeJson(res, code === 'NO_CLIENT' ? 503 : 400, {
            ok: false,
            error: code,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'browser-bridge: activate route')
  })

  await ctx.effect(async () => {
    if (startError) {
      logger?.warn?.(
        `[browser-bridge] bridge unavailable: ${startError.message}. Tools are registered but will report NO_BRIDGE/NO_CLIENT until a port is free.`,
      )
    }
    return async () => {
      await bridge.stop()
    }
  }, 'browser-bridge.lifecycle')
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    port: toInt(config.port, DEFAULT_PORT),
    portRange: toInt(config.portRange, DEFAULT_PORT_RANGE),
    heartbeatMs: toInt(config.heartbeatMs, 20_000),
    commandTimeoutMs: toInt(config.commandTimeoutMs, 15_000),
    maxConsole: toInt(config.maxConsole, 2000),
    maxNetwork: toInt(config.maxNetwork, 1000),
    maxBodyBytes: toInt(config.maxBodyBytes, 262_144),
    pairWindowMs: toInt(config.pairWindowMs, 60_000),
    pairMaxFailures: toInt(config.pairMaxFailures, 5),
    ...(typeof config.stateDir === 'string' && config.stateDir ? { stateDir: config.stateDir } : {}),
    ...(config.pairingEnabled === false ? { pairingEnabled: false } : {}),
    ...(config.autoPair === false ? { autoPair: false } : {}),
    ...(config.allowRepair === true ? { allowRepair: true } : {}),
  }
}

function toInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback
}

function jsonResponse(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  })
}

function writeJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(body)
}

export { BridgeServer, SYSTEM_PROMPT }
