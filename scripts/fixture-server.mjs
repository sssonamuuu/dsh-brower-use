#!/usr/bin/env node
/**
 * Tiny local page used for DSH Browser Bridge manual/e2e checks.
 *   node scripts/fixture-server.mjs
 *   open http://127.0.0.1:8099/
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 8099)
const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DSH Browser Bridge Fixture</title>
  <style>
    body { font: 15px system-ui, sans-serif; margin: 40px; max-width: 640px; }
    button, input { font: inherit; padding: 8px 10px; margin: 4px 0; }
    #log { margin-top: 16px; padding: 10px; background: #f3f4f6; border-radius: 8px; min-height: 20px; }
    #late { display: none; margin-top: 12px; color: #047857; }
    #late.ready { display: block; }
  </style>
</head>
<body>
  <h1>DSH Browser Bridge Fixture</h1>
  <p>Use this page to verify snapshot, click, type, console, network, wait and screenshots.</p>
  <label for="email">Email</label><br>
  <input id="email" name="email" type="text" placeholder="you@example.com" autocomplete="off">
  <p><button id="save" type="button">Save</button> <span id="log">not clicked</span></p>
  <p><button id="fail">Fail request</button> <button id="boom">Throw error</button></p>
  <p><button id="latebtn">Show late element</button></p>
  <div id="late" class="loaded">Late content is ready.</div>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      const email = document.getElementById('email').value
      document.getElementById('log').textContent = 'saved:' + email
    })
    document.getElementById('fail').addEventListener('click', async () => {
      const response = await fetch('/api/fail')
      const body = await response.text()
      console.log('fail response', response.status, body)
    })
    document.getElementById('boom').addEventListener('click', () => {
      setTimeout(() => { throw new Error('fixture boom') }, 0)
    })
    document.getElementById('latebtn').addEventListener('click', () => {
      setTimeout(() => document.getElementById('late').classList.add('ready'), 300)
    })
  </script>
</body>
</html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/api/fail') {
    res.writeHead(500, { 'content-type': 'application/json', 'x-fixture': '1' })
    res.end(JSON.stringify({ error: 'fixture failure', code: 42 }))
    return
  }
  if (url.pathname === '/csp') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'",
    })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>CSP Fixture</title></head><body><h1>CSP Fixture</h1><p>Eval should be blocked here.</p><button id="ok">OK</button></body></html>`)
    return
  }
  if (url.pathname === '/api/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }, 400)
    return
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fixture] http://127.0.0.1:${PORT}/`)
})
