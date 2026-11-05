// Pure code shared by the main process and the renderer, so it must not import Node or Electron modules.

export const STEPS = ['transcribe', 'clean', 'summarize']

// During a run the later steps will be redone, so their old files on disk do not count as done.
export function stepStates(done, run) {
  const runIndex = STEPS.indexOf(run?.step)
  return STEPS.map((step, i) => {
    if (i === runIndex) return run.error ? 'error' : 'running'
    if (run && !run.error) return i < runIndex ? 'done' : 'pending'
    return done.includes(step) ? 'done' : 'pending'
  })
}

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

const MAC_SYMBOLS = { CommandOrControl: '⌘', Alt: '⌥', Shift: '⇧' }

export function shortcutLabel(accelerator, platform) {
  const parts = accelerator.split('+')
  if (platform === 'darwin') return parts.map((part) => MAC_SYMBOLS[part] ?? part).join('')
  return parts.map((part) => (part === 'CommandOrControl' ? 'Ctrl' : part)).join('+')
}

// A global shortcut needs Ctrl/⌘ or Alt, otherwise it would swallow that key in every other app.
export function acceleratorFromKey({ code, ctrlKey, metaKey, altKey, shiftKey }) {
  const key = code.match(/^(?:Key|Digit)(\w)$/)?.[1] ?? code.match(/^F\d{1,2}$/)?.[0]
  if (!key || !(ctrlKey || metaKey || altKey)) return null
  const modifiers = [ctrlKey || metaKey ? 'CommandOrControl' : '', altKey ? 'Alt' : '', shiftKey ? 'Shift' : '']
  return [...modifiers.filter(Boolean), key].join('+')
}
