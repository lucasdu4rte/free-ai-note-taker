const { overlay } = window.api
const $ = (id) => document.getElementById(id)
const BARS = 20
const levels = new Array(BARS).fill(0)
const bars = levels.map(() => document.createElement('span'))
const PARTS = ['chips', 'badge', 'wave', 'progress', 'timer', 'stop', 'open']
let state = { phase: 'hidden' }
let clock

$('wave').append(...bars)

const VIEWS = {
  recording(current) {
    show('chips', 'badge', 'wave', 'timer', 'stop')
    $('chip-sources').textContent = current.sources
    $('chip-llm').textContent = `Resumo: ${current.llm}`
    setText(`Gravando ${current.sources.toLowerCase()}`, true)
    const tick = () => ($('timer').textContent = new Date(Date.now() - current.startedAt).toISOString().slice(11, 19))
    tick()
    clock = setInterval(tick, 1000)
  },
  processing(current) {
    show('progress')
    setText(current.status)
  },
  done(current) {
    show('open')
    $('open').textContent = 'Abrir'
    setText(`Ata pronta: ${current.title || 'reunião de agora'}`)
  },
  error(current) {
    show('open')
    $('open').textContent = 'Ver'
    setText(`A ata falhou: ${current.status}`)
  },
  hidden() {},
}

function show(...parts) {
  for (const part of PARTS) $(part).hidden = !parts.includes(part)
}

function setText(text, muted = false) {
  $('text').textContent = text
  $('text').classList.toggle('muted', muted)
}

function render(next) {
  state = next
  clearInterval(clock)
  VIEWS[state.phase](state)
}

overlay.onState(render)
overlay.onLevel((level) => {
  levels.push(level)
  levels.shift()
  bars.forEach((bar, i) => (bar.style.height = `${3 + Math.round(levels[i] * 21)}px`))
})

$('stop').onclick = () => overlay.stop()
$('open').onclick = () => overlay.openMeeting(state.id)
$('chip-sources').onclick = () => overlay.openSettings()
$('chip-llm').onclick = () => overlay.openSettings()

render(await overlay.getState())
