import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { QuotaSnapshot } from './protocol'

const SNAPSHOT: QuotaSnapshot = {
  updatedAt: Date.now(),
  notes: ['Grok: not signed in'],
  accounts: [
    {
      key: 'c',
      provider: 'Claude',
      account: 'Claude Code',
      source: 'Claude Code',
      plan: 'team',
      windows: [
        { label: '5h', scope: 'account', usedPercent: 40, resetsAt: Date.now() + 3_600_000 },
        { label: 'Weekly', scope: 'account', usedPercent: 70, resetsAt: null }
      ]
    },
    {
      key: 'o',
      provider: 'OpenRouter',
      account: '…abcd',
      source: 'pi',
      windows: [],
      balance: '$4.00 credits left'
    }
  ]
}

test('groups accounts by provider and saves a key', async () => {
  let refreshed = 0
  const host = mockHost({
    capabilities: ['storage:own', 'settings:own', 'secrets:own'],
    requests: { 'quota.get': ({ refresh }) => ((refreshed += refresh ? 1 : 0), SNAPSHOT) }
  })
  const view = await mount(panel, { host })
  assert.deepEqual(view.summary(), ['Heading "Agent Quota"'])
  assert.ok(view.find({ text: /60% left/ }), JSON.stringify(view.tree()).slice(0, 2000))
  assert.ok(view.find({ text: '$4.00 credits left' }))
  assert.ok(view.find({ text: /Grok: not signed in/ }))

  await view.toggle({ label: 'Keys' })
  await view.type({ label: 'OpenRouter API key' }, 'sk-or-test')
  await view.press(view.findAll({ text: 'Save' })[1])
  assert.equal(host.data().secrets['openrouter.key'], 'sk-or-test')
  assert.equal(refreshed, 1)

  await view.post('quota.updated', { ...SNAPSHOT, accounts: [] })
  assert.ok(
    view.summary().some((line) => line.includes('No accounts found')),
    view.summary().join('\n')
  )
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
