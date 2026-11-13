const $ = (id) => document.getElementById(id)
let status = null
let timer = null

async function request(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload })
    return response ?? { ok: false, error: 'no response from background worker' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function stateClass(state) {
  if (state === 'connected') return 'on'
  if (state === 'pairing_required') return 'pair'
  if (state === 'error') return 'err'
  return 'off'
}

function pillClass(state) {
  if (state === 'connected') return 'pill green'
  if (state === 'pairing_required' || state === 'connecting') return 'pill amber'
  if (state === 'error') return 'pill red'
  return 'pill'
}

function render(next) {
  if (!next) return
  status = next
  $('dot').className = `dot ${stateClass(next.state)}`
  $('statePill').className = pillClass(next.state)
  $('statePill').textContent = next.state
  $('sub').textContent = next.connected
    ? `${next.browser?.brand ?? 'Chromium'} ${next.browser?.browserVersion ?? ''} · 已连接`
    : next.tokenSet
      ? '已保存 token，等待连接'
      : '尚未配对'
  $('portLabel').textContent = next.port ? `127.0.0.1:${next.port}` : ''
  $('versionLabel').textContent = `v${next.extensionVersion} · bridge ${next.serverVersion ?? '?'}`
  $('pairSection').hidden = next.connected
  $('activeSection').hidden = !next.activeTab
  if (next.activeTab) {
    $('activeTitle').textContent = next.activeTab.title || '(no title)'
    $('activeUrl').textContent = next.activeTab.url || ''
  }
  const hint = next.lastError
    ? next.lastError
    : next.connected
      ? 'DSH 现在可以读取和操作当前标签页。'
      : next.tokenSet
        ? '后台会自动重连；也可以点“重连”。'
        : '输入 DSH 显示的 6 位配对码完成首次连接。'
  $('statusHint').textContent = hint
  const errorBox = $('error')
  errorBox.hidden = !next.lastError || next.state === 'connected'
  errorBox.textContent = next.lastError || ''
  $('reconnectBtn').disabled = !next.tokenSet
}

async function refresh() {
  const response = await request('dsh/get-status')
  if (response?.ok && response.status) render(response.status)
  else if (response?.error) {
    $('statusHint').textContent = response.error
  }
}

async function pair() {
  const code = $('pairCode').value.trim()
  if (!/^\d{6}$/.test(code)) {
    $('statusHint').textContent = '请输入 6 位数字配对码'
    return
  }
  $('pairBtn').disabled = true
  $('pairBtn').textContent = '配对中…'
  const response = await request('dsh/pair', { code })
  $('pairBtn').disabled = false
  $('pairBtn').textContent = 'Pair'
  if (!response?.ok) {
    $('statusHint').textContent = response?.error || '配对失败'
    return
  }
  $('pairCode').value = ''
  await refresh()
}

$('pairBtn').addEventListener('click', pair)
$('pairCode').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') pair()
})
$('reconnectBtn').addEventListener('click', async () => {
  $('reconnectBtn').disabled = true
  await request('dsh/reconnect')
  await refresh()
  $('reconnectBtn').disabled = false
})
$('testBtn').addEventListener('click', async () => {
  const log = $('testLog')
  log.hidden = false
  log.textContent = '扫描 127.0.0.1:47821-47830 …'
  const response = await request('dsh/test')
  const candidates = response?.candidates ?? []
  log.textContent = candidates.length
    ? candidates.map((item) => `${item.port}: ${item.hello?.app ?? '?'} v${item.hello?.version ?? '?'} protocol=${item.hello?.protocol ?? '?'} pairing=${item.hello?.pairing}`).join('\n')
    : response?.error || '没有找到 DSH bridge。确认 DSH 插件已启用。'
})
$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage())
$('helpLink').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#help') })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'dsh/status-changed' && message.status) render(message.status)
})

refresh()
timer = setInterval(refresh, 1500)
window.addEventListener('unload', () => clearInterval(timer))
