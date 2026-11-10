import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleMessage, isValidPort, startMcpServer, wslCommand } from '../src/mcp.js'

const MEETINGS = {
  list: () => [{ id: '2026-11-10 14-30-00', title: 'Planejamento', minutes: 30, hasSummary: true, preview: 'Escopo fechado' }],
  read: (id) => {
    if (id !== '2026-11-10 14-30-00') throw new Error(`Reunião não encontrada: ${id}`)
    return { summary: '# Planejamento\n\n## Próximos passos\n- [ ] Revisar o Contrato — Maria', transcript: '[00:01] Bom dia' }
  },
}

const call = (name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, MEETINGS, '1.0.0').result

test('initialize echoes a supported protocol version and falls back to the newest', () => {
  const init = (protocolVersion) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }, MEETINGS, '1.0.0').result
  assert.equal(init('2025-06-18').protocolVersion, '2025-06-18')
  assert.equal(init('1999-01-01').protocolVersion, '2025-11-25')
})

test('notifications get no response and unknown methods get an error', () => {
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, MEETINGS, '1.0.0'), undefined)
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, MEETINGS, '1.0.0').error.code, -32601)
})

test('tools read and search meetings', () => {
  assert.match(call('read_meeting', { id: '2026-11-10 14-30-00' }).content[0].text, /- \[ \] Revisar o Contrato[\s\S]*\[00:01\] Bom dia/)
  assert.deepEqual(JSON.parse(call('search_meetings', { query: 'contrato' }).content[0].text), [
    { id: '2026-11-10 14-30-00', title: 'Planejamento', matches: ['- [ ] Revisar o Contrato — Maria'] },
  ])
  assert.equal(call('read_meeting', { id: 'nope' }).isError, true)
  assert.equal(call('search_meetings', { query: ' ' }).isError, true)
})

test('only ports from 1024 to 65535 are valid', () => {
  assert.equal(isValidPort(47615), true)
  assert.equal(isValidPort(80), false)
  assert.equal(isValidPort(70000), false)
  assert.equal(isValidPort(4761.5), false)
})

test('the WSL command maps the exe to /mnt and keeps the bridge as a Windows path', () => {
  assert.equal(
    wslCommand(47615, 'C:\\Users\\Ana\\AppData\\Local\\Programs\\free-ai-note-taker\\Free AI Note Taker.exe', 'C:\\Users\\Ana\\app.asar\\src\\mcp-bridge.cjs'),
    "claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 --env WSLENV=ELECTRON_RUN_AS_NODE --transport stdio free-ai-notes -- '/mnt/c/Users/Ana/AppData/Local/Programs/free-ai-note-taker/Free AI Note Taker.exe' 'C:\\Users\\Ana\\app.asar\\src\\mcp-bridge.cjs' 47615",
  )
})

test('the HTTP server answers JSON-RPC and rejects web page origins', async () => {
  const server = await startMcpServer(0, MEETINGS, '1.0.0')
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  try {
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(list.status, 200)
    assert.equal((await list.json()).result.tools.length, 3)
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400)
    assert.equal((await fetch(url)).status, 405)
  } finally {
    server.close()
  }
})
