import http from 'node:http'

export const DEFAULT_MCP_PORT = 47615
export const MCP_PATH = '/mcp'
const SERVER_NAME = 'free-ai-notes'
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY_BYTES = 1_000_000
const MAX_MATCHES_PER_MEETING = 5
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

export const isValidPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535

const TOOLS = [
  {
    name: 'list_meetings',
    description: 'Lista as reuniões gravadas, da mais nova para a mais antiga, com id, título, duração em minutos e a primeira linha do resumo.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_meeting',
    description: 'Lê uma reunião: o resumo em Markdown (tarefas aparecem como "- [ ]" ou "- [x]") e a transcrição com horários.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'O id vindo de list_meetings, como "2026-11-10 14-30-00".' } }, required: ['id'] },
  },
  {
    name: 'search_meetings',
    description: 'Busca uma palavra ou trecho, sem diferenciar maiúsculas, nos títulos, resumos e transcrições de todas as reuniões.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
]

function searchMeetings(meetings, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) throw new Error('Informe o que buscar.')
  return meetings.list().flatMap((meeting) => {
    const { summary = '', transcript = '' } = meetings.read(meeting.id)
    const lines = [meeting.title, ...summary.split('\n'), ...transcript.split('\n')].filter((line) => line?.toLowerCase().includes(needle))
    return lines.length ? [{ id: meeting.id, title: meeting.title, matches: lines.slice(0, MAX_MATCHES_PER_MEETING).map((line) => line.trim()) }] : []
  })
}

const TOOL_HANDLERS = {
  list_meetings: (meetings) => JSON.stringify(meetings.list(), null, 2),
  read_meeting: (meetings, { id }) => {
    const { summary, transcript } = meetings.read(id)
    return `# Resumo\n\n${summary ?? '(ainda sem resumo)'}\n\n# Transcrição\n\n${transcript ?? '(ainda sem transcrição)'}`
  },
  search_meetings: (meetings, { query }) => JSON.stringify(searchMeetings(meetings, query), null, 2),
}

function callTool(meetings, { name, arguments: args = {} }) {
  const handler = TOOL_HANDLERS[name]
  if (!handler) return { content: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }], isError: true }
  try {
    return { content: [{ type: 'text', text: handler(meetings, args) }] }
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true }
  }
}

// Returns the JSON-RPC response, or undefined for notifications, which get no reply.
export function handleMessage(message, meetings, version) {
  if (message?.id === undefined) return undefined
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, title: 'Free AI Note Taker', version },
        instructions: 'Reuniões gravadas pelo Free AI Note Taker. Use list_meetings ou search_meetings para achar a reunião e read_meeting para ler o resumo e a transcrição.',
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      return reply(callTool(meetings, message.params ?? {}))
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Método não suportado: ${message.method}` } }
  }
}

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end()
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } })

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) req.destroy(new Error('Body too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// Stateless Streamable HTTP: every POST carries one JSON-RPC message and gets a plain JSON reply, no SSE stream.
export function startMcpServer(port, meetings, version) {
  const server = http.createServer(async (req, res) => {
    // A web page open in the browser could otherwise reach this port (DNS rebinding); local tools send no Origin.
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return send(res, 403, rpcError(-32000, 'Origin not allowed'))
    if (new URL(req.url, 'http://localhost').pathname !== MCP_PATH) return send(res, 404)
    if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end()
    const protocol = req.headers['mcp-protocol-version']
    if (protocol && !PROTOCOL_VERSIONS.includes(protocol)) return send(res, 400, rpcError(-32600, `Unsupported MCP-Protocol-Version: ${protocol}`))
    let message
    try {
      message = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, rpcError(-32700, 'Parse error'))
    }
    const response = handleMessage(message, meetings, version)
    send(res, response ? 200 : 202, response)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`

// WSL2 cannot reach Windows' 127.0.0.1, so Claude Code there runs this app's own .exe as plain Node through WSL interop
// and the bridge relays stdio to the HTTP server on Windows.
export function wslCommand(port, exePath, bridgePath) {
  const linuxExe = exePath.replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/')
  return `claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 --env WSLENV=ELECTRON_RUN_AS_NODE --transport stdio ${SERVER_NAME} -- ${shellQuote(linuxExe)} ${shellQuote(bridgePath)} ${port}`
}

export const mcpUrl = (port) => `http://127.0.0.1:${port}${MCP_PATH}`
export const httpCommand = (port) => `claude mcp add --scope user --transport http ${SERVER_NAME} ${mcpUrl(port)}`
