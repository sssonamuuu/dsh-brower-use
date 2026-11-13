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
    ...(config.allowRepair === true ? { allowRepair: true } : {}),
  }
}

function toInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback
}

export { BridgeServer, SYSTEM_PROMPT }
