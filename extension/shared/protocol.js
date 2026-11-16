/**
 * Protocol constants shared by the extension's module scripts.
 * Content scripts cannot import modules, so content/collector.js and
 * content/relay.js repeat the channel name.
 */
export const PROTOCOL_VERSION = 1
export const APP_ID = 'dsh-browser-bridge'
export const DEFAULT_PORT = 47821
export const PORT_RANGE = 10
export const EXTENSION_VERSION = '0.1.1'
export const HEARTBEAT_MS = 20_000
export const STORAGE = {
  token: 'dshBridge.token',
  port: 'dshBridge.port',
  serverVersion: 'dshBridge.serverVersion',
  autoConnect: 'dshBridge.autoConnect',
  armedTabs: 'dshBridge.armedTabs',
  lastError: 'dshBridge.lastError',
}
export const CAPS = ['tabs', 'dom', 'console', 'network', 'screenshot', 'input', 'frames']

/** Best-effort browser identity for the handshake. */
export function detectBrowser() {
  const ua = navigator.userAgent
  let brand = 'Chromium'
  if (/\bEdg\//.test(ua)) brand = 'Edge'
  else if (/\bOPR\//.test(ua)) brand = 'Opera'
  else if (/\bBrave\b/.test(ua)) brand = 'Brave'
  else if (/\bVivaldi\//.test(ua)) brand = 'Vivaldi'
  else if (/\bChrome\//.test(ua)) brand = 'Chrome'
  const version = /(?:Edg|OPR|Chrome|Vivaldi)\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown'
  return {
    browser: 'chromium',
    brand,
    browserVersion: version,
    extensionVersion: EXTENSION_VERSION,
    platform: navigator.platform || 'unknown',
    caps: CAPS,
  }
}
