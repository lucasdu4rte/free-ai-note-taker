// Runs under ELECTRON_RUN_AS_NODE from WSL: reads one JSON-RPC message per stdin line and relays it to the app's MCP server.
const readline = require('node:readline')

const url = `http://127.0.0.1:${process.argv[2]}/mcp`
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

async function relay(line) {
  const message = JSON.parse(line)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: line,
    })
    if (response.status === 202) return
    write(await response.json())
  } catch {
    if (message.id === undefined) return
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'O Free AI Note Taker não está aberto ou a conexão MCP está desligada.' } })
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) relay(line).catch((error) => process.stderr.write(`${error.message}\n`))
})
