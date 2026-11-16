/**
 * Shared protocol constants and error types for the host side.
 * Keep PROTOCOL_VERSION in sync with extension/shared/protocol.js.
 * @module dsh-browser-bridge/protocol
 */

export const PROTOCOL_VERSION = 1
export const APP_ID = 'dsh-browser-bridge'
export const PACKAGE_VERSION = '0.1.2'
export const DEFAULT_PORT = 47821
export const DEFAULT_PORT_RANGE = 10

export const CAPABILITIES = Object.freeze([
  'tabs',
  'dom',
  'console',
  'network',
  'screenshot',
  'input',
  'frames',
])

/** A command failed before/inside the extension. */
export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

/** Error codes understood by tools and tests. */
export const ERROR = Object.freeze({
  NO_BRIDGE: 'NO_BRIDGE',
  NO_CLIENT: 'NO_CLIENT',
  NO_TAB: 'NO_TAB',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  CLIENT_CLOSED: 'CLIENT_CLOSED',
  BAD_REQUEST: 'BAD_REQUEST',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',
  INTERNAL: 'INTERNAL',
})
