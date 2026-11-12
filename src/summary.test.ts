import { assert, test } from 'orca/testing'
import type { QuotaAccount, QuotaWindow } from './protocol'
import { accountHeadroom, statusBarState, summarize } from './summary'

const win = (usedPercent: number, scope: QuotaWindow['scope'] = 'account', label = 'w'): QuotaWindow => ({
  label,
  scope,
  usedPercent,
  resetsAt: null
})
const account = (provider: string, windows: QuotaWindow[], error?: string): QuotaAccount => ({
  key: `${provider}${Math.random()}`,
  provider,
  account: 'a',
  source: 's',
  windows,
  error
})

test('headroom is the tightest account window, else the roomiest model', () => {
  assert.equal(accountHeadroom(account('C', [win(30), win(70), win(99, 'model')]))?.remaining, 30)
  assert.equal(accountHeadroom(account('A', [win(100, 'model'), win(40, 'model')]))?.remaining, 60)
  assert.equal(accountHeadroom(account('C', [win(10)], 'expired')), null)
})

test('a pool counts its best account; the status bar names the provider closest to empty', () => {
  const summaries = summarize({
    accounts: [
      account('Codex', [win(100)]),
      account('Codex', [win(20)]),
      account('Claude', [win(95)]),
      account('Grok', [], 'unauthorized (HTTP 401)')
    ],
    notes: [],
    updatedAt: 0
  })
  assert.deepEqual(
    summaries.map((s) => [s.provider, s.best?.remaining, s.accounts, s.errors]),
    [
      ['Codex', 80, 2, 0],
      ['Claude', 5, 1, 0],
      ['Grok', undefined, 1, 1]
    ]
  )
  const state = statusBarState(summaries, [])
  assert.equal(state.text, 'Claude 5%')
  assert.equal(state.tone, 'danger')
  assert.match(state.tooltip, /Codex: 80% left \(best of 2\)/)
  assert.match(state.tooltip, /Grok: no limit data, 1 failing/)
  assert.equal(statusBarState(summaries, [' claude ']).text, 'Codex 80%')
  assert.equal(statusBarState([], []).text, 'Quota')
})
