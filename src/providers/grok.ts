// SuperGrok / Grok CLI credits: the billing endpoint Grok CLI itself calls.
import type { OAuthCred } from '../credentials'
import { clampPercent, getJson, num, toEpochMs, usd } from '../http'
import type { QuotaAccount, QuotaWindow } from '../protocol'
import { expiredAccount, isExpired, settle } from './account'

type Json = Record<string, unknown>

const BASE = 'https://cli-chat-proxy.grok.com/v1'

const money = (value: unknown): number | null => num((value as Json | null | undefined)?.val)

function periodLabel(type: unknown): string {
  const kind = String(type ?? '')
    .replace('USAGE_PERIOD_TYPE_', '')
    .toLowerCase()
  return kind ? kind[0].toUpperCase() + kind.slice(1) : 'Period'
}

/** The billing config, flat or under `config`; null when the response has none. */
export function parseGrokBilling(data: Json): { windows: QuotaWindow[]; plan?: string } | null {
  const config = (data.config as Json | undefined) ?? data
  const period = config.currentPeriod as Json | undefined
  const resetsAt = toEpochMs(period?.end ?? config.billingPeriodEnd)
  const plan = typeof config.subscriptionTier === 'string' ? config.subscriptionTier : undefined
  const percent = num(config.creditUsagePercent)
  if (percent !== null) {
    return {
      plan,
      windows: [
        { label: periodLabel(period?.type), scope: 'account', usedPercent: clampPercent(percent), resetsAt }
      ]
    }
  }
  const limit = money(config.monthlyLimit)
  const used = money(config.used)
  if (limit !== null && used !== null && limit > 0) {
    return {
      plan,
      windows: [
        {
          label: 'Monthly',
          scope: 'account',
          usedPercent: clampPercent((used / limit) * 100),
          detail: `${usd(used)} of ${usd(limit)}`,
          resetsAt
        }
      ]
    }
  }
  return plan ? { plan, windows: [] } : null
}

export async function fetchGrok(cred: OAuthCred): Promise<QuotaAccount> {
  const base = { provider: 'Grok', source: cred.source, account: cred.account ?? cred.source }
  if (isExpired(cred)) {
    return expiredAccount(base, cred.source === 'Grok CLI' ? 'grok' : cred.source)
  }
  return settle(base, async () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.token}`,
      'X-XAI-Token-Auth': 'xai-grok-cli'
    }
    if (cred.userId) {
      headers['x-userid'] = cred.userId
    }
    const credits = parseGrokBilling((await getJson(`${BASE}/billing?format=credits`, headers)) as Json)
    if (credits && credits.windows.length > 0) {
      return credits
    }
    // Some accounts expose their monthly budget only in the default billing view.
    const fallback = parseGrokBilling((await getJson(`${BASE}/billing`, headers)) as Json)
    return fallback ?? credits ?? { error: 'billing response had no usage' }
  })
}
