/**
 * Minimal RFC 6455 WebSocket server support.
 *
 * The host plugin deliberately has no runtime dependencies, so instead of
 * pulling in `ws` we implement the subset the extension needs: text frames,
 * fragmentation, ping/pong, close, 16/64-bit lengths, and client masking.
 *
 * @module dsh-browser-bridge/ws
 */
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

/** Compute the Sec-WebSocket-Accept value for a client key. */
export function acceptKey(clientKey) {
  return createHash('sha1').update(`${clientKey}${GUID}`).digest('base64')
}

/** True when the incoming request is a WebSocket upgrade. */
export function isWebSocketUpgrade(req) {
  const upgrade = String(req.headers?.upgrade ?? '').toLowerCase()
  return upgrade === 'websocket' && typeof req.headers?.['sec-websocket-key'] === 'string'
}

/**
 * Encode one unfragmented server frame. Server frames are not masked.
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** Close a TCP socket after writing a proper WebSocket close frame. */
function sendClose(socket, code = 1000, reason = '') {
  if (socket.destroyed) return
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  try {
    socket.write(encodeFrame(OPCODE.CLOSE, payload))
  } catch {
    // the peer may already be gone
  }
}

/**
 * Upgrade an HTTP socket and wrap it in a small event-based WebSocket connection.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{ maxPayload?: number, onOpen?: (conn: WebSocketConnection) => void }} [options]
 * @returns {WebSocketConnection}
 */
export function upgradeSocket(req, socket, head, options = {}) {
  const key = req.headers['sec-websocket-key']
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n',
  ].join('\r\n')
  socket.write(response)
  const conn = new WebSocketConnection(socket, options)
  if (head && head.length > 0) conn.feed(head)
  return conn
}

/**
 * Server-side WebSocket connection.
 *
 * Events: `message` (string, isBinary), `close`, `error`.
 */
export class WebSocketConnection {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = 0
  #closed = false
  #maxPayload
  #listeners = new Map()

  constructor(socket, { maxPayload = 16 * 1024 * 1024 } = {}) {
    this.#socket = socket
    this.#maxPayload = maxPayload
    socket.setNoDelay?.(true)
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('error', (error) => {
      this.#emit('error', error)
      this.#finish()
    })
    socket.on('close', () => this.#finish())
    socket.on('end', () => this.#finish())
  }

  get open() {
    return !this.#closed && !this.#socket.destroyed
  }

  on(event, listener) {
    const set = this.#listeners.get(event) ?? new Set()
    set.add(listener)
    this.#listeners.set(event, set)
    return () => set.delete(listener)
  }

  #emit(event, ...args) {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        listener(...args)
      } catch {
        // listener failures must not break the frame loop
      }
    }
  }

  #finish() {
    if (this.#closed) return
    this.#closed = true
    this.#emit('close')
  }

  /** Feed raw TCP bytes into the frame parser. */
  feed(chunk) {
    if (this.#closed) return
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    try {
      while (this.#parseFrame()) {
        // keep parsing buffered frames
      }
    } catch (error) {
      this.#emit('error', error)
      this.terminate()
    }
  }

  #parseFrame() {
    const buf = this.#buffer
    if (buf.length < 2) return false
    const first = buf[0]
    const second = buf[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < offset + 2) return false
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return false
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ws: frame too large')
      length = Number(big)
      offset += 8
    }
    if (length > this.#maxPayload) throw new Error(`ws: frame exceeds ${this.#maxPayload} bytes`)
    const maskOffset = offset
    if (masked) offset += 4
    if (buf.length < offset + length) return false
    let payload = buf.subarray(offset, offset + length)
    if (masked) {
      const mask = buf.subarray(maskOffset, maskOffset + 4)
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i & 3]
      payload = unmasked
    }
    this.#buffer = buf.subarray(offset + length)

    if (opcode === OPCODE.CLOSE) {
      sendClose(this.#socket, 1000, '')
      this.#socket.end()
      this.#finish()
      return false
    }
    if (opcode === OPCODE.PING) {
      if (this.open) this.#socket.write(encodeFrame(OPCODE.PONG, payload))
      return true
    }
    if (opcode === OPCODE.PONG) {
      this.#emit('pong', payload)
      return true
    }
    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (this.#fragments.length > 0) throw new Error('ws: interleaved fragmented message')
      this.#fragmentOpcode = opcode
      if (fin) {
        this.#deliver(opcode, payload)
      } else {
        this.#fragments.push(payload)
      }
      return true
    }
    if (opcode === OPCODE.CONTINUATION) {
      if (this.#fragments.length === 0 && !fin) {
        // a continuation with no start cannot be interpreted; ignore it
        return true
      }
      this.#fragments.push(payload)
      if (fin) {
        const full = Buffer.concat(this.#fragments)
        if (full.length > this.#maxPayload) throw new Error('ws: fragmented message too large')
        this.#deliver(this.#fragmentOpcode, full)
        this.#fragments = []
        this.#fragmentOpcode = 0
      }
      return true
    }
    // Unknown opcode: protocol violation.
    throw new Error(`ws: unsupported opcode ${opcode}`)
  }

  #deliver(opcode, payload) {
    const text = payload.toString('utf8')
    this.#emit('message', text, opcode === OPCODE.BINARY)
  }

  /** Send a text frame. */
  send(text) {
    if (!this.open) throw new Error('ws: connection is closed')
    this.#socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8')))
  }

  /** Send a ping frame. */
  ping(payload = Buffer.alloc(0)) {
    if (!this.open) return
    this.#socket.write(encodeFrame(OPCODE.PING, payload))
  }

  /** Close gracefully. */
  close(code = 1000, reason = '') {
    if (this.#closed) return
    sendClose(this.#socket, code, reason)
    this.#socket.end()
    this.#finish()
  }

  /** Close immediately. */
  terminate() {
    this.#socket.destroy()
    this.#finish()
  }
}
