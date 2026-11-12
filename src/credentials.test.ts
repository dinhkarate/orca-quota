import { assert, test } from 'orca/testing'
import { apiKeys, nineRouterOrigins, type AgentConfig } from './credentials'

const PI: AgentConfig = {
  source: 'pi',
  auth: {
    openrouter: { type: 'api_key', key: 'sk-or-literal' },
    OPENROUTER_API_KEY: { type: 'api_key', key: "!$HOME/bin/pi-key 'OpenRouter'" },
    NAMED_KEY: { type: 'api_key', key: 'sk-or-named' }
  },
  providers: [
    { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '$NAMED_KEY' },
    { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '!never-run' },
    { baseUrl: 'https://9router.example.dev/v1', apiKey: 'x' }
  ]
}

test('api keys: plugin secret first, env refs resolved, commands never run, duplicates dropped', () => {
  const keys = apiKeys([PI, { ...PI, source: 'omp' }], {
    secret: 'sk-or-literal',
    env: 'OPENROUTER_API_KEY',
    authIds: ['openrouter'],
    host: 'openrouter.ai'
  })
  assert.deepEqual(keys, [
    { key: 'sk-or-literal', source: 'Orca' },
    { key: 'sk-or-named', source: 'pi' }
  ])
})

test('9router origins come from pi and omp providers', () => {
  assert.deepEqual(nineRouterOrigins([PI]), ['https://9router.example.dev'])
})
