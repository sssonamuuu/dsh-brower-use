import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

test('client @ source maps open tabs to candidates and serializable references', async (t) => {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        captured.entry = entry
      },
    },
  }
  await import(pathToFileURL(path.join(root, 'packages/dsh-browser-bridge/lib/client.js')).href)
  assert.equal(captured.entry.id, '@sssonamuuu/dsh-browser-bridge')
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
  }
  const exports = captured.entry.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['inputTriggers'])

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/browser-bridge/tabs')
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          browser: { brand: 'Edge', engine: 'chromium', version: '157.0.0.0' },
          tabs: [
            { id: 7, windowId: 1, title: 'Local app', url: 'http://localhost:3000/', favIconUrl: 'http://localhost:3000/favicon.ico', active: true, browser: 'Edge' },
            { id: 8, windowId: 1, title: 'Docs', url: 'http://localhost:3000/docs', favIconUrl: '', active: false, discarded: true, browser: 'Chrome' },
            { id: 9, windowId: 1, title: 'Arc page', url: 'http://localhost:3000/arc', favIconUrl: '', active: false, browser: 'Arc' },
            { id: 10, windowId: 1, title: 'Another Edge', url: 'http://localhost:3000/edge2', favIconUrl: '', active: false, browser: 'Edge' },
          ],
        }
      },
    }
  }
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.window })

  let source
  const ctx = {
    get(name) {
      assert.equal(name, 'inputTriggers')
      return { registerSource(value) { source = value; return () => {} } }
    },
    effect(callback) { return callback() },
  }
  exports.apply(ctx)
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'browser-tab')

  const rows = await source.candidates({}, { query: '', signal: new AbortController().signal })
  assert.equal(rows.length, 4)
  assert.equal(rows[0].name, 'Local app')
  assert.match(textOf(rows[0].section), /Edge 浏览器标签/)
  assert.equal(rows[1].name, 'Another Edge')
  assert.equal(rows[1].section, rows[0].section, 'same-browser rows share one section object')
  assert.match(textOf(rows[2].section), /Chrome 浏览器标签/)
  const edgeLogo = rows[0].section.children.find((child) => child?.type === 'img')
  assert.match(edgeLogo.props.src, /^data:image\/svg\+xml/)
  assert.match(textOf(rows[3].section), /^A浏览器标签$/)
  assert.match(rows[0].description, /localhost:3000/)
  assert.match(rows[0].description, /当前/)
  assert.match(rows[2].description, /已休眠/)
  assert.equal(typeof rows[0].icon, 'function')
  const icon = rows[0].icon({ size: 14 })
  assert.equal(icon.type, 'span')
  const faviconImage = icon.children.find((child) => child?.type === 'img')
  assert.equal(faviconImage.props.src, 'http://localhost:3000/favicon.ico')

  const filtered = await source.candidates({}, { query: 'docs', signal: new AbortController().signal })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].name, 'Docs')

  const picked = source.onPick({ candidate: rows[0] })
  assert.equal(picked.insert.source, 'browser-tab')
  assert.equal(picked.insert.label, 'Local app')
  assert.match(picked.insert.clipboardText, /Browser tab id=7/)
  const serialized = await source.codec.serialize(picked.insert.ref)
  assert.match(serialized, /\[Browser tab id=7\] Local app — http:\/\/localhost:3000\//)
  assert.equal(source.openReference(), false)
})
