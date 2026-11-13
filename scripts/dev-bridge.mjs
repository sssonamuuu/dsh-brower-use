#!/usr/bin/env node
/**
 * Standalone bridge for extension/protocol debugging without starting DSH.
 *
 *   node scripts/dev-bridge.mjs
 *   node scripts/dev-bridge.mjs --port 47900
 *
 * Prints the pairing code and keeps running. Press Ctrl+C to stop.
 */
import { BridgeServer } from '../packages/dsh-browser-bridge/lib/bridge-server.js'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.DSH_BRIDGE_PORT || 47821)
const stateDir = process.env.DSH_BRIDGE_STATE_DIR || new URL('../.dev-bridge/', import.meta.url).pathname

const bridge = new BridgeServer({ port, portRange: 1, stateDir })
bridge.on('client-connected', (status) => {
  console.log(`[dev] extension connected: ${status.clients.map((client) => `${client.brand} ${client.browserVersion}`).join(', ')}`)
})
bridge.on('client-disconnected', ({ reason }) => {
  console.log(`[dev] extension disconnected: ${reason}`)
})
bridge.on('browser-event', (event) => {
  if (['console', 'network.response', 'network.error', 'tab.updated'].includes(event.event)) {
    console.log(`[dev] event ${event.event} tab=${event.tabId}`)
  }
})

await bridge.start()
console.log(`[dev] bridge ready: ${bridge.url}`)
console.log(`[dev] pairing code: ${bridge.pairingCode}`)
console.log(`[dev] token file: ${bridge.stateFile}`)
console.log('[dev] load extension/ in Chrome, enter the pairing code, then run DSH tools against this bridge')

const stop = async () => {
  console.log('\n[dev] stopping…')
  await bridge.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
