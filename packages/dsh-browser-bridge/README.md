---
description: "DSH host plugin that registers browser_* tools and runs the loopback WebSocket bridge for the DSH Browser Bridge extension."
kind: "package-reference"
---

# dsh-browser-bridge

Host half of [DSH Browser Bridge](../../README.md). It starts an HTTP/WebSocket
server on loopback, pairs with the browser extension, buffers console/network
events, and registers the `browser_*` tools on `ctx.tools`.

This package intentionally has **no runtime dependencies**: it implements the
WebSocket server itself and uses raw JSON Schema tool definitions. That keeps a
linked profile package resolvable without a local `node_modules`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `47821` | First port to try |
| `portRange` | `10` | Try `port..port+portRange-1` when busy |
| `stateDir` | `$DSH_HOME/browser-bridge` | Token + pairing state (0600) |
| `pairingEnabled` | `true` | Allow `/pair` |
| `allowRepair` | `false` | Allow pairing while a client is connected |
| `heartbeatMs` | `20000` | Extension ping interval contract |
| `commandTimeoutMs` | `15000` | Default command timeout |
| `maxConsole` | `2000` | Console entries retained per tab |
| `maxNetwork` | `1000` | Network requests retained per tab |
| `maxBodyBytes` | `262144` | Response body cap |

## Tools

`browser_status`, `browser_tabs`, `browser_snapshot`, `browser_read`,
`browser_screenshot`, `browser_click`, `browser_type`, `browser_press`,
`browser_scroll`, `browser_eval`, `browser_console`, `browser_network`,
`browser_wait`.

All results are user-facing text; screenshots return a file path for
`read_image`.

## Notes

- The plugin registers tools even when the port is busy; calls then fail with a
  clear bridge error instead of preventing DSH from starting.
- `ctx.get('workingDirectory')` is optional: without it, screenshots go to
  `process.cwd()/.dsh-browser/screenshots`.
- The system prompt gets a short `tool:browser` section describing when to use
  the tools.
