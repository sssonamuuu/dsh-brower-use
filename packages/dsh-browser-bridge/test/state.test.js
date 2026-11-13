import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserState } from '../lib/browser-state.js'

test('console ring buffer caps entries and counts levels', () => {
  const state = new BrowserState({ maxConsole: 3 })
  for (let index = 0; index < 5; index++) {
    state.handle({ tabId: 1, seq: index + 1, event: 'console', data: { level: index === 4 ? 'error' : 'log', text: `line ${index}`, args: [] } })
  }
  const data = state.consoleFor(1)
  assert.equal(data.entries.length, 3)
  assert.equal(data.entries[0].text, 'line 2')
  assert.equal(data.entries[2].text, 'line 4')
  assert.equal(data.levels.error, 1)
  assert.equal(data.levels.log, 2)
  const errors = state.consoleFor(1, { level: 'error' })
  assert.equal(errors.entries.length, 1)
  const incremental = state.consoleFor(1, { sinceSeq: 4 })
  assert.equal(incremental.entries.length, 1)
})

test('network records merge request/response/body and cap the body', () => {
  const state = new BrowserState({ maxBodyBytes: 10 })
  state.handle({ tabId: 2, seq: 1, event: 'network.request', data: { id: 'r1', method: 'post', url: 'http://localhost/api', type: 'fetch' } })
  state.handle({ tabId: 2, seq: 2, event: 'network.response', data: { id: 'r1', status: 500, statusText: 'Err', durationMs: 9 } })
  state.handle({ tabId: 2, seq: 3, event: 'network.body', data: { id: 'r1', body: 'abcdefghijklmnop', size: 16 } })
  const detail = state.networkGet(2, 'r1')
  assert.equal(detail.method, 'POST')
  assert.equal(detail.status, 500)
  assert.equal(detail.bodyTruncated, true)
  assert.match(detail.body, /abcdefghij/)
  const list = state.networkFor(2)
  assert.equal(list.requests[0].bodySize ?? 16, 16)
})

test('network filters by method, status class, URL and type', () => {
  const state = new BrowserState()
  state.handle({ tabId: 3, seq: 1, event: 'network.request', data: { id: 'a', method: 'GET', url: 'http://x/ok', type: 'fetch' } })
  state.handle({ tabId: 3, seq: 2, event: 'network.response', data: { id: 'a', status: 200 } })
  state.handle({ tabId: 3, seq: 3, event: 'network.request', data: { id: 'b', method: 'POST', url: 'http://x/fail', type: 'xhr' } })
  state.handle({ tabId: 3, seq: 4, event: 'network.response', data: { id: 'b', status: 500 } })
  state.handle({ tabId: 3, seq: 5, event: 'network.request', data: { id: 'c', method: 'GET', url: 'http://x/pending', type: 'fetch' } })
  assert.equal(state.networkFor(3, { status: '5xx' }).requests.length, 1)
  assert.equal(state.networkFor(3, { status: 'pending' }).requests.length, 1)
  assert.equal(state.networkFor(3, { method: 'post' }).requests.length, 1)
  assert.equal(state.networkFor(3, { urlContains: 'fail' }).requests.length, 1)
  assert.equal(state.networkFor(3, { type: 'fetch' }).requests.length, 2)
})

test('clear operations and tab stats work', () => {
  const state = new BrowserState()
  state.handle({ tabId: 4, seq: 1, event: 'console', data: { level: 'log', text: 'x', args: [] } })
  state.handle({ tabId: 4, seq: 2, event: 'network.request', data: { id: 'r', method: 'GET', url: 'http://x/' } })
  assert.deepEqual(state.stats(), { tabs: 1, console: 1, network: 1 })
  state.clearConsole()
  state.clearNetwork()
  assert.deepEqual(state.stats(), { tabs: 1, console: 0, network: 0 })
})
