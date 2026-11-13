const $ = (id) => document.getElementById(id)
let status = null
let timer = null
let initialized = false

async function request(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload })
    return response ?? { ok: false, error: 'no response from background worker' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function pillClass(state) {
  if (state === 'connected') return 'pill green'
  if (state === 'pairing_required' || state === 'connecting') return 'pill amber'
  if (state === 'error') return 'pill red'
  return 'pill'
}

function dotClass(state) {
  if (state === 'connected') return 'dot on'
  if (state === 'pairing_required' || state === 'connecting') return 'dot pair'
  if (state === 'error') return 'dot err'
  return 'dot off'
}

function render(next) {
  if (!next) return
  status = next
  $('dot').className = dotClass(next.state)
  $('statePill').className = pillClass(next.state)
  $('statePill').textContent = next.connected ? 'connected' : next.state
  $('browser').textContent = next.browser ? `${next.browser.brand} ${next.browser.browserVersion} · ${next.browser.platform}` : '—'
  $('extVersion').textContent = next.extensionVersion ?? '—'
  $('bridgeVersion').textContent = next.serverVersion ?? '—'
  $('port').textContent = next.port ? `127.0.0.1:${next.port}` : '—'
  $('activeTab').textContent = next.activeTab ? `${next.activeTab.title || '(no title)'} — ${next.activeTab.url || ''}` : '—'
  $('lastError').textContent = next.lastError || '—'
  $('pairCard').hidden = next.connected
  $('token').placeholder = next.tokenSet ? '已保存（留空保持不变）' : '自动配对后这里会有值'
  if (!initialized) {
    initialized = true
    $('portInput').value = next.port ?? ''
    $('autoConnect').checked = next.autoConnect !== false
  }
}

async function refresh() {
  const response = await request('dsh/get-status')
  if (response?.ok && response.status) render(response.status)
}

async function pair() {
  const code = $('pairCode').value.trim()
  const errorBox = $('pairError')
  errorBox.hidden = true
  if (!/^\d{6}$/.test(code)) {
    errorBox.textContent = '请输入 6 位数字配对码'
    errorBox.hidden = false
    return
  }
  $('pairBtn').disabled = true
  $('pairBtn').textContent = '配对中…'
  const response = await request('dsh/pair', { code })
  $('pairBtn').disabled = false
  $('pairBtn').textContent = 'Pair'
  if (!response?.ok) {
    errorBox.textContent = response?.error || '配对失败'
    errorBox.hidden = false
    return
  }
  $('pairCode').value = ''
  $('pairHint').textContent = `配对成功，已连接 127.0.0.1:${response.port}。`
  await refresh()
}

async function save() {
  const token = $('token').value.trim()
  const port = $('portInput').value.trim()
  const autoConnect = $('autoConnect').checked
  const hint = $('saveHint')
  if (token && !/^[a-f0-9]{64}$/.test(token)) {
    hint.textContent = 'token 必须是 64 位十六进制字符串'
    hint.className = 'hint error'
    return
  }
  const response = await request('dsh/save', {
    ...(token ? { token } : {}),
    ...(port ? { port: Number(port) } : {}),
    autoConnect,
  })
  if (!response?.ok) {
    hint.textContent = response?.error || '保存失败'
    hint.className = 'hint error'
    return
  }
  hint.textContent = response.status?.connected ? '已保存并连接。' : '已保存，后台正在重连。'
  hint.className = 'hint ok'
  $('token').value = ''
  await refresh()
}

async function test() {
  const log = $('testLog')
  log.hidden = false
  log.textContent = '扫描 127.0.0.1:47821-47830 …'
  const response = await request('dsh/test')
  const candidates = response?.candidates ?? []
  log.textContent = candidates.length
    ? candidates.map((item) => `${item.port}: ${item.hello?.app ?? '?'} v${item.hello?.version ?? '?'} protocol=${item.hello?.protocol ?? '?'} pairing=${item.hello?.pairing}`).join('\n')
    : response?.error || '没有找到 DSH bridge。确认 DSH 插件已启用、端口未被占用。'
}

$('pairBtn').addEventListener('click', pair)
$('pairCode').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') pair()
})
$('saveBtn').addEventListener('click', save)
$('forgetBtn').addEventListener('click', async () => {
  if (!confirm('清除本地 token 并重新自动发现 DSH？')) return
  await request('dsh/forget')
  $('saveHint').textContent = '已清除 token，正在自动重新发现 DSH。'
  $('saveHint').className = 'hint'
  await refresh()
})
$('reconnectBtn').addEventListener('click', async () => {
  $('reconnectBtn').disabled = true
  const response = await request('dsh/reconnect')
  $('reconnectBtn').disabled = false
  if (!response?.ok) {
    $('testLog').hidden = false
    $('testLog').textContent = response?.error || '重连失败'
  }
  await refresh()
})
$('testBtn').addEventListener('click', test)
$('refreshBtn').addEventListener('click', refresh)

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'dsh/status-changed' && message.status) render(message.status)
})

if (location.hash === '#help') {
  setTimeout(() => $('help').scrollIntoView({ behavior: 'smooth' }), 100)
}

refresh()
timer = setInterval(refresh, 2000)
window.addEventListener('unload', () => clearInterval(timer))
