#!/usr/bin/env node
/**
 * End-to-end harness for the Chrome extension without touching the user's
 * normal Chrome profile.
 *
 * Launches a temporary Chrome with --remote-debugging-pipe, loads this
 * repository's `extension/` through the CDP Extensions.loadUnpacked command,
 * injects the bridge token, opens a fixture page, and stays alive until
 * SIGTERM. Requires a running DSH bridge on 127.0.0.1:47821 (or DSH_BRIDGE_PORT).
 *
 *   node scripts/e2e-chrome.mjs
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '../extension')
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profileDir = process.env.CHROME_PROFILE || '/tmp/dsh-chrome-verify'
const bridgePort = Number(process.env.DSH_BRIDGE_PORT || 47821)
const fixturePort = Number(process.env.FIXTURE_PORT || 8099)
const stateFile = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'browser-bridge', 'state.json')

const state = JSON.parse(await readFile(stateFile, 'utf8'))
const token = state.token
if (!token) throw new Error(`no bridge token in ${stateFile}`)
const pairMode = process.argv.includes('--pair') || process.env.E2E_PAIR === '1'
const pairCode = process.env.E2E_PAIR_CODE || state.pairCode

const chrome = spawn(chromePath, [
  `--user-data-dir=${profileDir}`,
  '--enable-unsafe-extension-debugging',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })

const input = chrome.stdio[3]
const output = chrome.stdio[4]
let buffer = ''
const pending = new Map()
let nextId = 0

output.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!raw) continue
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      continue
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`))
      else entry.resolve(message.result)
    }
  }
})

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
  })
}

async function attach(targetId) {
  const result = await call('Target.attachToTarget', { targetId, flatten: true })
  return result.sessionId
}

async function evaluate(sessionId, expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId)
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed')
  }
  return result.result?.value
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForBridge(clientCount = 1, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await (await fetch(`http://127.0.0.1:${bridgePort}/health`)).json()
      if (health.clients >= clientCount) return health
    } catch {
      // bridge not ready
    }
    await sleep(250)
  }
  throw new Error(`bridge did not see a client within ${timeoutMs}ms`)
}

let closed = false
async function close() {
  if (closed) return
  closed = true
  try {
    await call('Browser.close')
  } catch {
    // ignore
  }
  setTimeout(() => {
    try { chrome.kill('SIGTERM') } catch { /* ignore */ }
    process.exit(0)
  }, 300)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)

try {
  await sleep(2500)
  const loaded = await call('Extensions.loadUnpacked', { path: extensionPath })
  const extensionId = loaded.id
  console.log(`[e2e] extension loaded: ${extensionId}`)
  await sleep(800)

  const targets = await call('Target.getTargets')
  const worker = targets.targetInfos.find((target) => target.type === 'service_worker' && target.url.includes(`${extensionId}/background.js`))
  if (!worker) throw new Error('extension service worker target not found')
  if (pairMode) {
    // Exercise the real pairing path: extension page -> fetch /pair -> WS connect.
    const options = await call('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` })
    await sleep(600)
    const optionsSession = await attach(options.targetId)
    await call('Runtime.enable', {}, optionsSession)
    const pairResult = await evaluate(optionsSession, `chrome.runtime.sendMessage({ type: 'dsh/pair', code: ${JSON.stringify(pairCode)} })`)
    console.log(`[e2e] pair result: ${JSON.stringify(pairResult)}`)
    if (!pairResult?.ok) throw new Error(`pairing failed: ${pairResult?.error ?? 'unknown'}`)
    await call('Target.closeTarget', { targetId: options.targetId }).catch(() => {})
  } else {
    const workerSession = await attach(worker.targetId)
    await call('Runtime.enable', {}, workerSession)
    await evaluate(workerSession, `chrome.storage.local.set(${JSON.stringify({
      'dshBridge.token': token,
      'dshBridge.port': bridgePort,
    })}).then(() => { setTimeout(() => chrome.runtime.reload(), 80); return 'stored' })`)
  }

  const health = await waitForBridge(1)
  console.log(`[e2e] extension connected: ${JSON.stringify(health.active)}`)

  const page = await call('Target.createTarget', { url: `http://127.0.0.1:${fixturePort}/` })
  console.log(`[e2e] fixture page target: ${page.targetId}`)
  await sleep(1000)
  console.log('[e2e] READY')
  if (process.argv.includes('--reload-test')) {
    const workerTargets = (await call('Target.getTargets')).targetInfos
    const currentWorker = workerTargets.find((target) => target.type === 'service_worker' && target.url.includes(`${extensionId}/background.js`))
    if (!currentWorker) throw new Error('service worker target not found for reload test')
    const currentSession = await attach(currentWorker.targetId)
    await call('Runtime.enable', {}, currentSession)
    console.log('[e2e] reloading extension service worker…')
    await evaluate(currentSession, 'chrome.runtime.reload(); "reloading"')
    await sleep(1500)
    const reconnected = await waitForBridge(1, 20_000)
    console.log(`[e2e] RECONNECTED: ${JSON.stringify(reconnected.active)}`)
  }
  console.log('[e2e] run browser_* tools against this Chrome; send SIGTERM to close it')
} catch (error) {
  console.error('[e2e] failed:', error.message)
  await close()
}

setInterval(() => {}, 1 << 30)
