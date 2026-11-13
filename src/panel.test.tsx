import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { QuotaSnapshot, UsageRange, UsageReport } from './protocol'

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

const row = (key: string, tokens: number, cost: number, unpriced = 0) => ({
  key,
  label: key,
  tokens,
  cost,
  calls: 3,
  unpriced
})

function usage(range: UsageRange): UsageReport {
  return {
    range,
    updatedAt: Date.now(),
    scanning: null,
    totals: {
      input: 2_000,
      output: 500,
      cacheRead: 1_200_000,
      cacheWrite: 0,
      reasoning: 100,
      calls: 6,
      tokens: 1_202_500,
      cost: 12.5,
      unpriced: 1_000
    },
    agents: [row('Claude Code', 1_201_500, 12.5), row('pi', 1_000, 0, 1_000)],
    models: [row('claude-opus-5-5', 1_201_500, 12.5)],
    projects: [row('/work/app', 1_202_500, 12.5)],
    series:
      range === '7d'
        ? Array.from({ length: 7 }, (_, i) => ({ label: `2026-11-0${i + 1}`, tokens: i * 1000, cost: i }))
        : []
  }
}

test('usage first: totals, a range with its chart, and a breakdown table', async () => {
  const ranges: string[] = []
  const host = mockHost({
    capabilities: ['storage:own', 'settings:own', 'secrets:own'],
    requests: {
      'usage.get': ({ range }) => (ranges.push(range), usage(range)),
      'quota.get': () => SNAPSHOT
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.summary().includes('Heading "Agent Usage"'), view.summary().join('\n'))
  assert.ok(view.find({ text: '1.2M' }), JSON.stringify(view.tree()).slice(0, 3000))
  assert.ok(view.find({ text: '$12.50' }))
  assert.ok(view.find({ text: /1\.0K unpriced/ }))
  assert.deepEqual(view.rowsOf({ label: 'Usage by agent' }), ['Claude Code', 'pi'])

  await view.press({ text: '7 days' })
  assert.deepEqual(ranges, ['today', '7d'])
  assert.ok(view.find({ text: /Peak/ }))

  await view.select({ label: 'Break down by' }, 'models')
  assert.deepEqual(view.rowsOf({ label: 'Usage by model' }), ['claude-opus-5-5'])

  await view.post('usage.updated', { updatedAt: Date.now() })
  assert.equal(ranges.at(-1), '7d')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('the quota tab groups accounts by provider and saves a key', async () => {
  let refreshed = 0
  const host = mockHost({
    capabilities: ['storage:own', 'settings:own', 'secrets:own'],
    requests: {
      'usage.get': ({ range }) => usage(range),
      'quota.get': ({ refresh }) => ((refreshed += refresh ? 1 : 0), SNAPSHOT)
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'View' }, 'quota')
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
