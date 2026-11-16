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
          clientPath = clientModules?.clientPath?.('dsh-browser-bridge') ?? null
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

export { BridgeServer, SYSTEM_PROMPT }
