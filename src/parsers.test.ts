// Provider parsers against response shapes the endpoints send.
import { assert, test } from 'orca/testing'
import { parseClaudeUsage } from './providers/claude'
import { parseCodexUsage } from './providers/codex'
import { parseCopilotUser } from './providers/copilot'
import { parseDeepSeekBalance } from './providers/deepseek'
import { parseGrokBilling } from './providers/grok'
import { parseNineRouterUsage } from './providers/ninerouter'
import { parseOpenRouterKey } from './providers/openrouter'

test('claude: 5h and weekly gate the account, per-model weeks do not', () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 38, resets_at: '2026-11-12T10:00:00Z' },
    seven_day: { utilization: 61, resets_at: '2026-11-15T10:00:00Z' },
    seven_day_opus: { utilization: 12, resets_at: null },
    seven_day_sonnet: null,
    limits: [
      { kind: 'weekly_scoped', percent: 80, resets_at: null, scope: { model: { display_name: 'Fable' } } }
    ]
  })
  assert.deepEqual(
    windows.map((w) => [w.label, w.scope, w.usedPercent]),
    [
      ['5h', 'account', 38],
      ['Weekly', 'account', 61],
      ['Weekly opus', 'model', 12],
      ['Weekly Fable', 'model', 80]
    ]
  )
  assert.equal(windows[0].resetsAt, Date.parse('2026-11-12T10:00:00Z'))
})

test('codex: windows named by length, review and credits', () => {
  const parsed = parseCodexUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1_800_100_000 }
    },
    code_review_rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } },
    credits: { has_credits: true, unlimited: false, balance: '4.5' }
  })
  assert.deepEqual(
    parsed.windows.map((w) => [w.label, w.scope, w.usedPercent]),
    [
      ['5h', 'account', 20],
      ['Weekly', 'account', 55],
      ['Review Weekly', 'model', 5]
    ]
  )
  assert.equal(parsed.windows[0].resetsAt, 1_800_000_000_000)
  assert.equal(parsed.plan, 'plus')
  assert.equal(parsed.balance, '$4.50 credits')
})

test('grok: weekly credit percent, else monthly budget', () => {
  const weekly = parseGrokBilling({
    config: {
      creditUsagePercent: 30,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-16T00:00:00Z' },
      subscriptionTier: 'SuperGrok'
    }
  })
  assert.deepEqual(
    weekly?.windows.map((w) => [w.label, w.usedPercent]),
    [['Weekly', 30]]
  )
  assert.equal(weekly?.plan, 'SuperGrok')
  const monthly = parseGrokBilling({ monthlyLimit: { val: '50' }, used: { val: 12.5 } })
  assert.deepEqual(
    monthly?.windows.map((w) => [w.label, w.usedPercent, w.detail]),
    [['Monthly', 25, '$12.50 of $50.00']]
  )
  assert.equal(parseGrokBilling({}), null)
})

test('copilot: paid snapshots skip unlimited ones; free plan counts what is left', () => {
  const paid = parseCopilotUser({
    login: 'octo',
    copilot_plan: 'individual',
    quota_reset_date: '2026-12-01',
    quota_snapshots: {
      chat: { unlimited: true, entitlement: 0 },
      premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80, unlimited: false }
    }
  })
  assert.deepEqual(
    paid.windows.map((w) => [w.label, w.usedPercent, w.detail]),
    [['Premium requests', 20, '240 of 300 left']]
  )
  assert.equal(paid.account, 'octo')
  const free = parseCopilotUser({ monthly_quotas: { chat: 50 }, limited_user_quotas: { chat: 10 } })
  assert.deepEqual(
    free.windows.map((w) => [w.label, w.usedPercent]),
    [['Chat', 80]]
  )
})

test('openrouter: key limit as a window, no limit as spend', () => {
  const limited = parseOpenRouterKey({
    data: { label: 'pi', limit: 10, limit_remaining: 2.5, usage: 7.5, limit_reset: null }
  })
  assert.deepEqual(
    limited.windows.map((w) => [w.usedPercent, w.detail]),
    [[75, '$2.50 left of $10.00']]
  )
  assert.equal(limited.account, 'pi')
  const open = parseOpenRouterKey({ data: { limit: null, usage: 3 } })
  assert.equal(open.windows.length, 0)
  assert.equal(open.balance, '$3.00 used, no key limit')
})

test('deepseek: balances per currency', () => {
  const parsed = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '12.3' },
      { currency: 'USD', total_balance: '1' }
    ]
  })
  assert.equal(parsed.balance, '¥12.30 + $1.00 left')
  assert.equal(
    parseDeepSeekBalance({ is_available: false, balance_infos: [] }).error,
    'balance too low to make requests'
  )
})

test('9router: normalized quotas, credit balances, and connections without a usage API', () => {
  const codex = parseNineRouterUsage('codex', {
    plan: 'free',
    quotas: {
      session: { used: 100, total: 100, remaining: 0, resetAt: '2026-11-17T03:03:10.000Z' },
      review_weekly: { used: 10, total: 100 }
    }
  })
  assert.deepEqual(
    codex?.windows.map((w) => [w.label, w.scope, w.usedPercent]),
    [
      ['Session', 'account', 100],
      ['Review weekly', 'model', 10]
    ]
  )
  const agy = parseNineRouterUsage('antigravity', {
    quotas: { 'gemini-x': { used: 0, total: 1000, remainingPercentage: 100, displayName: 'Gemini X' } }
  })
  assert.deepEqual(
    agy?.windows.map((w) => [w.label, w.scope, w.usedPercent]),
    [['Gemini X', 'model', 0]]
  )
  const ds = parseNineRouterUsage('deepseek', {
    quotas: { b: { total: 4, isCreditBalance: true, currency: 'USD' } }
  })
  assert.equal(ds?.balance, '4.00 USD left')
  assert.equal(parseNineRouterUsage('xai', { message: 'Usage API not implemented for xai' }), null)
  assert.equal(
    parseNineRouterUsage('qoder', { message: 'Qoder connected. Usage fetch returned 401.' })?.error,
    'Qoder connected. Usage fetch returned 401.'
  )
})
