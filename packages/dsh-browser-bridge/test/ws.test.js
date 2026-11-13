import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptKey, encodeFrame } from '../lib/ws.js'
import { makeBridge, FakeExtension } from './helpers.js'

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('encodeFrame uses 7-bit, 16-bit, and 64-bit lengths', () => {
  const short = encodeFrame(0x1, Buffer.alloc(5))
  assert.equal(short[0], 0x81)
  assert.equal(short[1], 5)

  const medium = encodeFrame(0x1, Buffer.alloc(200))
  assert.equal(medium[0], 0x81)
  assert.equal(medium[1], 126)
  assert.equal(medium.readUInt16BE(2), 200)

  const large = encodeFrame(0x1, Buffer.alloc(70_000))
  assert.equal(large[0], 0x81)
  assert.equal(large[1], 127)
  assert.equal(Number(large.readBigUInt64BE(2)), 70_000)
})

test('bridge accepts masked frames of all lengths and buffers events', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const fake = await new FakeExtension(bridge).connect()
  t.after(() => fake.close())

  const payloads = ['short', 'm'.repeat(200), 'l'.repeat(70_000)]
  payloads.forEach((payload, index) => {
    fake.event(1, 'console', { level: 'log', text: payload, args: [payload] }, index + 1)
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const data = bridge.state.consoleFor(1, { limit: 10 })
  assert.equal(data.entries.length, 3)
  assert.equal(data.entries[0].text, 'short')
  assert.equal(data.entries[1].text, 'm'.repeat(200))
  assert.equal(data.entries[2].text, 'l'.repeat(70_000))
})

test('bridge rejects a bad WebSocket token', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=deadbeef`)
  const outcome = await new Promise((resolve) => {
    ws.onopen = () => resolve('open')
    ws.onerror = () => resolve('error')
    ws.onclose = () => resolve('close')
    setTimeout(() => resolve('timeout'), 2500)
  })
  assert.notEqual(outcome, 'open')
  try { ws.close() } catch { /* ignore */ }
})

test('ping receives pong', async (t) => {
  const { bridge, cleanup } = await makeBridge()
  t.after(cleanup)
  const fake = await new FakeExtension(bridge, {
    onCommand: () => ({}),
  }).connect()
  t.after(() => fake.close())
  fake.send({ type: 'ping', ts: 42 })
  const pong = await fake.waitFor((message) => message.type === 'pong')
  assert.equal(pong.ts, 42)
})
