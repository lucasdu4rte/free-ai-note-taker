// Pure parsing shared by the main process and the renderer, so it must not import Node or Electron modules.

export function parseSummary(markdown = '') {
  const lines = markdown.split('\n')
  let title = ''
  const sections = []
  lines.forEach((line, index) => {
    if (!title && !sections.length && line.startsWith('# ')) {
      title = line.slice(2).trim()
      return
    }
    if (line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), items: [] })
      return
    }
    if (!line.trim()) return
    if (!sections.length) sections.push({ heading: '', items: [] })
    sections.at(-1).items.push({ ...parseItem(line), index })
  })
  return { title, sections }
}

function parseItem(line) {
  const task = line.match(/^\s*[-*] \[([ xX])\] (.*)$/)
  if (task) return { kind: 'task', done: task[1] !== ' ', text: plain(task[2]) }
  const bullet = line.match(/^\s*(?:[-*]|\d+\.) (.*)$/)
  if (bullet) return { kind: 'bullet', text: plain(bullet[1]) }
  return { kind: 'text', text: plain(line.trim()) }
}

const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, '$1')

export function summaryPreview(markdown) {
  const first = parseSummary(markdown).sections.flatMap((section) => section.items)[0]
  return first?.text ?? ''
}

export function toggleTask(markdown, index, done) {
  const lines = markdown.split('\n')
  lines[index] = lines[index].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]')
  return lines.join('\n')
}

export function parseTranscript(text = '') {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\[([\d:]+)\]\s*(.*)$/)
      return match ? { time: match[1], text: match[2] } : { time: '', text: line.trim() }
    })
}
