import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

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
  assert.equal(captured.entry.id, 'dsh-browser-bridge')
  const exports = captured.entry.factory()
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
          tabs: [
            { id: 7, windowId: 1, title: 'Local app', url: 'http://localhost:3000/', active: true },
            { id: 8, windowId: 1, title: 'Docs', url: 'http://localhost:3000/docs', active: false, discarded: true },
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
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Local app')
  assert.match(rows[0].description, /localhost:3000/)
  assert.match(rows[0].description, /active/)
  assert.match(rows[1].description, /discarded/)

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
