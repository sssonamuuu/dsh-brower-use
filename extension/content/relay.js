/**
 * ISOLATED world relay.
 *
 * MAIN-world scripts cannot use chrome.runtime, so the collector posts events
 * on window. This script verifies the source/window and channel, then forwards
 * them to the background service worker where tabId/frameId are stamped.
 */
(() => {
  if (window.__DSH_RELAY__) return
  try {
    Object.defineProperty(window, '__DSH_RELAY__', { value: true, enumerable: false, configurable: false })
  } catch {
    window.__DSH_RELAY__ = true
  }

  const CHANNEL = 'dsh-browser-collector'

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.__dsh !== CHANNEL || typeof data.type !== 'string') return
    try {
      const result = chrome.runtime.sendMessage({
        type: 'dsh/event',
        payload: {
          type: data.type,
          data: data.data,
          ts: Number(data.ts) || Date.now(),
          seq: Number(data.seq) || 0,
        },
      })
      // Chrome returns a promise in MV3; an unhandled rejection happens when the
      // service worker is restarting, which is expected and safe to ignore.
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      // extension reloading / invalidated context
    }
  })
})()
