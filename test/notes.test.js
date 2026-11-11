import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEPS, acceleratorFromKey, downloadProgressText, parseSummary, parseTranscript, stepStates, summaryPreview, shortcutLabel, toggleTask } from '../src/notes.js'

const SUMMARY = `# Planejamento da sprint 42

## Resumo
O time fechou o **escopo** da sprint.

## Decisões
- Lançamento adiado para 15/11

## Próximos passos
- [ ] Terminar a integração com o Teams — João, sex
- [x] Revisar o contrato — Maria`

test('a summary is split into its title, sections and tasks', () => {
  const { title, sections } = parseSummary(SUMMARY)

  assert.equal(title, 'Planejamento da sprint 42')
  assert.deepEqual(sections.map((s) => s.heading), ['Resumo', 'Decisões', 'Próximos passos'])
  assert.deepEqual(sections[0].items[0], { kind: 'text', text: 'O time fechou o escopo da sprint.', index: 3 })
  assert.equal(sections[1].items[0].kind, 'bullet')
  assert.deepEqual(sections[2].items.map((i) => [i.kind, i.done]), [['task', false], ['task', true]])
})

test('summaries written before titles existed still parse', () => {
  const { title, sections } = parseSummary('## Resumo\nReunião curta.')
  assert.equal(title, '')
  assert.equal(summaryPreview('## Resumo\nReunião curta.'), 'Reunião curta.')
  assert.equal(sections.length, 1)
})

test('checking a task rewrites only its line', () => {
  const task = parseSummary(SUMMARY).sections[2].items[0]
  const updated = toggleTask(SUMMARY, task.index, true)

  assert.equal(parseSummary(updated).sections[2].items[0].done, true)
  assert.equal(updated.split('\n').length, SUMMARY.split('\n').length)
})

test('transcript lines keep their timestamps', () => {
  assert.deepEqual(parseTranscript('[00:04] Bom dia.\n\n[1:02:05] Tchau.'), [
    { time: '00:04', text: 'Bom dia.' },
    { time: '1:02:05', text: 'Tchau.' },
  ])
})

test('a step shows the current run when it has one, otherwise what is on disk', () => {
  assert.deepEqual(stepStates(['transcribe'], undefined), ['done', 'pending', 'pending'])
  assert.deepEqual(stepStates(STEPS, { step: 'clean', detail: 'Revisando o texto 1/3' }), ['done', 'running', 'pending'])
  assert.deepEqual(stepStates(STEPS, { step: 'clean', error: 'HTTP 503' }), ['done', 'error', 'done'])
})

test('a pressed key combination becomes a global shortcut', () => {
  const press = (code, mods = {}) => acceleratorFromKey({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
  assert.equal(press('KeyR', { ctrlKey: true, altKey: true }), 'CommandOrControl+Alt+R')
  assert.equal(press('Digit5', { metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+5')
  assert.equal(press('F9', { altKey: true }), 'Alt+F9')
  assert.equal(press('KeyR', { shiftKey: true }), null)
  assert.equal(press('ControlLeft', { ctrlKey: true }), null)
})

test('shortcuts are labelled the way each system shows them', () => {
  assert.equal(shortcutLabel('CommandOrControl+Alt+R', 'win32'), 'Ctrl+Alt+R')
  assert.equal(shortcutLabel('CommandOrControl+Alt+R', 'darwin'), '⌘⌥R')
})

test('the update progress says how much was downloaded, how much is left and how fast', () => {
  assert.equal(downloadProgressText({ transferred: 12_300_000, total: 85_000_000, bytesPerSecond: 2_000_000 }), '12,3 MB de 85,0 MB · faltam 72,7 MB · 2,0 MB/s · ~37 s')
  assert.equal(downloadProgressText({ transferred: 0, total: 85_000_000, bytesPerSecond: 0 }), '0,0 MB de 85,0 MB · faltam 85,0 MB')
})
