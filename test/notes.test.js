import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSummary, parseTranscript, summaryPreview, toggleTask } from '../src/notes.js'

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
