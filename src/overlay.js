const { overlay } = window.api
const $ = (id) => document.getElementById(id)
const BARS = 20
const levels = new Array(BARS).fill(0)
const bars = levels.map(() => document.createElement('span'))
const PARTS = ['chips', 'badge', 'wave', 'sources', 'timer', 'stop']
let state = { phase: 'hidden' }
let clock

$('wave').append(...bars)

const VIEWS = {
  recording(current) {
    renderCollapsed(current.collapsed)
    if (current.collapsed) return show('badge')
    show('chips', 'badge', 'wave', 'sources', 'timer', 'stop')
    $('chip-llm').textContent = `Resumo by ${current.llm}`
    const label = current.micMuted ? 'Desmutar microfone' : 'Mutar microfone'
    $('mic').setAttribute('aria-pressed', String(current.micMuted))
    $('mic').setAttribute('aria-label', label)
    $('mic').title = label
    // SVG elements have no `hidden` property, only the attribute.
    $('mic-on').toggleAttribute('hidden', current.micMuted)
    $('mic-off').toggleAttribute('hidden', !current.micMuted)
    $('speaker').toggleAttribute('hidden', !current.systemAudio)
    const tick = () => ($('timer').textContent = new Date(Date.now() - current.startedAt).toISOString().slice(11, 19))
    tick()
    clock = setInterval(tick, 1000)
  },
  hidden() {},
}

function renderCollapsed(collapsed) {
  const label = collapsed ? 'Expandir a barra de gravação' : 'Minimizar a barra'
  $('bar').classList.toggle('collapsed', Boolean(collapsed))
  $('logo').setAttribute('aria-expanded', String(!collapsed))
  $('logo').setAttribute('aria-label', label)
  $('logo').title = label
}

function show(...parts) {
  for (const part of PARTS) $(part).hidden = !parts.includes(part)
}

function render(next) {
  state = next
  clearInterval(clock)
  VIEWS[state.phase](state)
}

overlay.onState(render)
const applyOpacity = (percent) => document.documentElement.style.setProperty('--opacity', percent / 100)
overlay.onOpacity(applyOpacity)
overlay.onLevel((level) => {
  levels.push(level)
  levels.shift()
  bars.forEach((bar, i) => (bar.style.height = `${3 + Math.round(levels[i] * 21)}px`))
})

$('stop').onclick = () => overlay.stop()
$('logo').onclick = () => overlay.setCollapsed(!state.collapsed)
$('mic').onclick = () => overlay.toggleMic()
$('chip-llm').onclick = () => overlay.openSettings()

applyOpacity(await overlay.getOpacity())
render(await overlay.getState())
