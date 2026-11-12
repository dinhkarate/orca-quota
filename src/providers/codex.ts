// ChatGPT plan limits for Codex: GET chatgpt.com/backend-api/wham/usage.
import type { OAuthCred } from '../credentials'
import { clampPercent, getJson, num, toEpochMs, usd } from '../http'
import type { QuotaAccount, QuotaWindow } from '../protocol'
import { expiredAccount, isExpired, settle } from './account'

type Json = Record<string, unknown>

function windowLabel(seconds: number | null, fallback: string): string {
  if (seconds === null || seconds <= 0) {
    return fallback
  }
  if (seconds === 604_800) {
    return 'Weekly'
  }
  return seconds % 86_400 === 0 ? `${seconds / 86_400}d` : `${Math.round(seconds / 3600)}h`
}

function windowsOf(limit: unknown, prefix: string, scope: QuotaWindow['scope']): QuotaWindow[] {
  const body = limit as Json | null | undefined
  const out: QuotaWindow[] = []
  for (const [key, fallback] of [
    ['primary_window', '5h'],
    ['secondary_window', 'Weekly']
  ] as const) {
    const block = body?.[key] as Json | null | undefined
    const used = num(block?.used_percent)
    if (used === null) {
      continue
    }
    const label = windowLabel(num(block?.limit_window_seconds), fallback)
    out.push({
      label: prefix ? `${prefix} ${label}` : label,
      scope,
      usedPercent: clampPercent(used),
      resetsAt: toEpochMs(block?.reset_at)
    })
  }
  return out
}

export function parseCodexUsage(data: Json): { windows: QuotaWindow[]; plan?: string; balance?: string } {
  const windows = windowsOf(data.rate_limit, '', 'account')
  windows.push(...windowsOf(data.code_review_rate_limit, 'Review', 'model'))
  for (const extra of Array.isArray(data.additional_rate_limits)
    ? (data.additional_rate_limits as Json[])
    : []) {
    const name = String(extra?.limit_name ?? extra?.metered_feature ?? 'Extra')
    windows.push(...windowsOf(extra?.rate_limit, name, 'model'))
  }
  const credits = data.credits as Json | null | undefined
  const balance = num(credits?.balance)
  return {
    windows,
    plan: typeof data.plan_type === 'string' ? data.plan_type : undefined,
    balance:
      credits?.unlimited === true
        ? 'unlimited credits'
        : credits?.has_credits === true && balance !== null
          ? `${usd(balance)} credits`
          : undefined
  }
}

export async function fetchCodex(cred: OAuthCred): Promise<QuotaAccount> {
  const base = {
    provider: 'Codex',
    source: cred.source,
    account: cred.account ?? cred.accountId ?? cred.source
  }
  if (isExpired(cred)) {
    return expiredAccount(base, cred.source === 'Codex' ? 'codex' : cred.source)
  }
  return settle(base, async () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.token}`,
      'User-Agent': 'codex-cli',
      'OpenAI-Beta': 'codex-1',
      originator: 'Codex Desktop'
    }
    if (cred.accountId) {
      headers['ChatGPT-Account-Id'] = cred.accountId
    }
    return parseCodexUsage((await getJson('https://chatgpt.com/backend-api/wham/usage', headers)) as Json)
  })
}
