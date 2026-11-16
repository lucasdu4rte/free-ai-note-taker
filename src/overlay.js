const { overlay } = window.api
const $ = (id) => document.getElementById(id)
const BARS = 20
const BALL_BARS = 4
const bars = Array.from({ length: BARS }, () => document.createElement('span'))
const ballBars = Array.from({ length: BALL_BARS }, () => document.createElement('span'))
const PARTS = ['chips', 'badge', 'wave', 'sources', 'timer', 'stop']
let smoothedLevel = 0
let state = { phase: 'hidden' }
let clock

$('wave').append(...bars)
$('eq').append(...ballBars)

const VIEWS = {
  recording(current) {
    const collapsed = Boolean(current.collapsed)
    $('bar').classList.remove('leaving')
    $('ball').classList.remove('leaving')
    $('bar').hidden = collapsed
    $('ball-wrap').hidden = !collapsed
    if (collapsed) return show()
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
  hidden() {
    $('bar').hidden = false
    $('ball-wrap').hidden = true
  },
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
// Mirrored equalizer: bars rise from the center, with a little jitter so steady speech still looks alive.
const jitter = () => 0.7 + 0.3 * Math.random()
const centerWeight = (index) => 1 - Math.abs(index - (BARS - 1) / 2) / (BARS / 2)
overlay.onLevel((level) => {
  smoothedLevel += (level - smoothedLevel) * 0.5
  bars.forEach((bar, i) => (bar.style.height = `${3 + Math.round(smoothedLevel * 21 * (0.35 + 0.65 * centerWeight(i)) * jitter())}px`))
  ballBars.forEach((bar, i) => (bar.style.height = `${4 + Math.round(smoothedLevel * 18 * (i % 3 ? 1 : 0.7) * jitter())}px`))
})

$('stop').onclick = () => overlay.stop()
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

function leaveThen(element, done) {
  if (reducedMotion.matches) return done()
  element.classList.add('leaving')
  // The class stays until the next render swaps the views, so the faded-out element never flashes back.
  element.addEventListener('animationend', done, { once: true })
}

$('minimize').onclick = () => leaveThen($('bar'), () => overlay.setCollapsed(true))

// The ball is both a button and a handle. The main process moves the window from the real cursor position:
// moving it from this page's pointer events fed back on itself, since every move shifted the pointer under the page.
$('ball').onpointerdown = (event) => {
  $('ball').setPointerCapture(event.pointerId)
  overlay.startDrag()
}
const endDrag = async () => {
  const { moved } = await overlay.endDrag()
  if (!moved) leaveThen($('ball'), () => overlay.setCollapsed(false))
}
$('ball').onpointerup = endDrag
$('ball').onpointercancel = () => overlay.endDrag()
$('ball').onlostpointercapture = () => overlay.endDrag()
// Mouse clicks are handled on pointerup; this covers Enter and Space, which click without a pointer (detail 0).
$('ball').onclick = (event) => {
  if (event.detail === 0) leaveThen($('ball'), () => overlay.setCollapsed(false))
}
$('mic').onclick = () => overlay.toggleMic()
$('chip-llm').onclick = () => overlay.openSettings()

applyOpacity(await overlay.getOpacity())
render(await overlay.getState())
