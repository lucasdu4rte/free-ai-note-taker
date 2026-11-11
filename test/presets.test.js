import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withSettingsDefaults } from '../src/presets.js'

test('settings saved before reserves existed get none and the time limit of their service', () => {
  const transcription = { provider: 'local', apiKey: '' }
  const saved = { transcription, llm: { provider: 'gemini', apiKey: 'k', model: 'gemini-3.8-flash', baseURL: 'u', mode: '' } }

  const settings = withSettingsDefaults(saved)

  assert.deepEqual(settings.llmFallbacks, [])
  assert.equal(settings.llm.timeoutSeconds, '30')
  assert.equal(settings.llm.apiKey, 'k')
  assert.equal(settings.transcription, transcription)
  assert.equal(withSettingsDefaults({ ...saved, llm: { provider: 'ollama' } }).llm.timeoutSeconds, '0')
  assert.equal(withSettingsDefaults({ ...saved, llm: { provider: 'removed-service' } }).llm.timeoutSeconds, '30')
})

test('a time limit and reserves the user chose are kept', () => {
  const settings = withSettingsDefaults({
    transcription: {},
    llm: { provider: 'gemini', timeoutSeconds: '0' },
    llmFallbacks: [{ provider: 'groq' }],
  })

  assert.equal(settings.llm.timeoutSeconds, '0')
  assert.deepEqual(settings.llmFallbacks, [{ timeoutSeconds: '30', provider: 'groq' }])
})

test('each provider keeps its last config, and the providers in use win over older ones', () => {
  const settings = withSettingsDefaults({
    transcription: {},
    llm: { provider: 'gemini', apiKey: 'new' },
    llmProfiles: { gemini: { provider: 'gemini', apiKey: 'old' }, anthropic: { provider: 'anthropic', apiKey: 'a' } },
  })

  assert.equal(settings.llmProfiles.gemini.apiKey, 'new')
  assert.notEqual(settings.llmProfiles.gemini, settings.llm)
  assert.equal(settings.llmProfiles.anthropic.apiKey, 'a')
  assert.equal(settings.llmProfiles.anthropic.timeoutSeconds, '30')
})
