// OpenRouter key limit and credits: GET openrouter.ai/api/v1/key and /api/v1/credits.
import type { KeyCred } from '../credentials'
import { clampPercent, getJson, num, toEpochMs, usd } from '../http'
import type { QuotaAccount, QuotaWindow } from '../protocol'
import { settle } from './account'

type Json = Record<string, unknown>

export function parseOpenRouterKey(body: Json): {
  windows: QuotaWindow[]
  account?: string
  balance?: string
} {
  const data = (body.data ?? {}) as Json
  const limit = num(data.limit)
  const remaining = num(data.limit_remaining)
  const usage = num(data.usage)
  const budgets = Array.isArray(data.budgets) ? (data.budgets as Json[]) : []
  const windows: QuotaWindow[] = []
  if (limit !== null && limit > 0 && remaining !== null) {
    windows.push({
      label: typeof data.limit_reset === 'string' ? `Key limit (${data.limit_reset})` : 'Key limit',
      scope: 'account',
      usedPercent: clampPercent(((limit - remaining) / limit) * 100),
      detail: `${usd(remaining)} left of ${usd(limit)}`,
      resetsAt: toEpochMs(budgets[0]?.resets_at)
    })
  }
  return {
    windows,
    account: typeof data.label === 'string' ? data.label : undefined,
    balance: windows.length === 0 && usage !== null ? `${usd(usage)} used, no key limit` : undefined
  }
}

export async function fetchOpenRouter(cred: KeyCred): Promise<QuotaAccount> {
  const base = { provider: 'OpenRouter', source: cred.source, account: `…${cred.key.slice(-4)}` }
  return settle(base, async () => {
    const headers = { Authorization: `Bearer ${cred.key}` }
    const found = parseOpenRouterKey((await getJson('https://openrouter.ai/api/v1/key', headers)) as Json)
    // Account credits; a key without access to them still has its own limit above.
    const credits = (await getJson('https://openrouter.ai/api/v1/credits', headers).catch(
      () => null
    )) as Json | null
    const data = (credits?.data ?? null) as Json | null
    const total = num(data?.total_credits)
    const used = num(data?.total_usage)
    if (total !== null && used !== null) {
      found.balance = `${usd(total - used)} credits left`
    }
    return found
  })
}
