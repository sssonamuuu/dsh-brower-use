import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

test('plugin apply starts the bridge, registers tools, and disposes cleanly', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-plugin-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const definitions = new Map()
  const disposers = []
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section)
            return () => {}
          },
        }
      }
      return undefined
    },
    async effect(callback) {
      const dispose = await callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }

  await apply(ctx, { port: 0, portRange: 1, stateDir })
  const expected = [
    'browser_status',
    'browser_tabs',
    'browser_snapshot',
    'browser_read',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_eval',
    'browser_console',
    'browser_network',
    'browser_wait',
  ]
  assert.deepEqual([...definitions.keys()].sort(), expected.sort())
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:browser')

  const status = await definitions.get('browser_status').execute({}, { signal: new AbortController().signal })
  assert.match(status, /Bridge: listening on http:\/\/127\.0\.0\.1:\d+/)
  const port = /127\.0\.0\.1:(\d+)/.exec(status)[1]
  const hello = await fetch(`http://127.0.0.1:${port}/hello`)
  assert.equal(hello.status, 200)

  for (const dispose of disposers.reverse()) await dispose()
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/hello`))
})
