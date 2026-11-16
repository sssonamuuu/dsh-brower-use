import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '../lib/protocol.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const extensionDir = path.join(root, 'extension')

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full))
    else files.push(full)
  }
  return files
}

test('extension manifest is valid MV3 and injects collectors only on demand', async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  assert.ok(manifest.permissions.includes('tabs'))
  assert.ok(manifest.permissions.includes('scripting'))
  assert.ok(manifest.host_permissions.includes('<all_urls>'))
  assert.equal(manifest.background.type, 'module')
  assert.ok(manifest.permissions.includes('debugger'))
  // Do not auto-inject MAIN-world hooks on every page; @-picking a tab attaches CDP.
  assert.equal(manifest.content_scripts, undefined)
  const background = await readFile(path.join(extensionDir, 'background.js'), 'utf8')
  assert.match(background, /collector\.ensure/)
  assert.match(background, /armedTabs/)
  assert.match(background, /chrome\.debugger/)
  assert.match(background, /Network\.enable/)
})

test('extension and host agree on the protocol version', async () => {
  const extensionProtocol = await import(path.join(extensionDir, 'shared/protocol.js'))
  assert.equal(extensionProtocol.PROTOCOL_VERSION, PROTOCOL_VERSION)
  assert.equal(extensionProtocol.APP_ID, 'dsh-browser-bridge')
})

test('all extension scripts parse with node --check', async () => {
  const files = (await walk(extensionDir)).filter((file) => file.endsWith('.js'))
  assert.ok(files.length >= 6)
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file}\n${result.stderr}`)
  }
})

test('extension icons exist and are PNG', async () => {
  for (const size of [16, 32, 48, 128]) {
    const file = path.join(extensionDir, 'icons', `icon${size}.png`)
    const stats = await stat(file)
    assert.ok(stats.size > 100)
    const buffer = await readFile(file)
    assert.equal(buffer.toString('ascii', 1, 4), 'PNG')
  }
})

test('background imports the injected page scripts', async () => {
  const background = await readFile(path.join(extensionDir, 'background.js'), 'utf8')
  assert.match(background, /page-scripts\.js/)
  assert.match(background, /pageAction/)
  assert.match(background, /pageEval/)
  assert.match(background, /chrome\.scripting\.executeScript/)
  assert.match(background, /captureVisibleTab/)
  assert.match(background, /x-dsh-bridge-client/)
  assert.match(background, /auto-pair|autoPair|AUTO_PAIR_HEADER/i)
})

test('collector hooks console, fetch, XHR and errors', async () => {
  const collector = await readFile(path.join(extensionDir, 'content/collector.js'), 'utf8')
  for (const marker of ['console[level]', 'window.fetch', 'XMLHttpRequest.prototype', 'unhandledrejection', "addEventListener('error'"]) {
    assert.match(collector, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('service worker bounds every command and answers a chrome-free ping', async () => {
  const source = await readFile(path.join(extensionDir, 'background.js'), 'utf8')
  // A stuck chrome.* binding must surface as an error, never as host silence.
  assert.match(source, /COMMAND_DEADLINES/)
  assert.match(source, /EXTENSION_UNRESPONSIVE/)
  assert.match(source, /withDeadline\(runAction\(action, params\)/)
  // system.ping must not touch chrome.* so it can prove the worker is alive.
  const pingBlock = source.slice(source.indexOf("case 'system.ping'"))
  const nextCase = pingBlock.indexOf('case ', 10)
  const body = pingBlock.slice(0, nextCase === -1 ? 400 : nextCase)
  assert.doesNotMatch(body, /chrome\./)
})
