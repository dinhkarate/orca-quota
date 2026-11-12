// Claude subscription limits: GET api.anthropic.com/api/oauth/usage with the Claude Code OAuth token.
import type { OAuthCred } from '../credentials'
import { clampPercent, getJson, num, toEpochMs } from '../http'
import type { QuotaAccount, QuotaWindow } from '../protocol'
import { expiredAccount, isExpired, settle } from './account'

type Json = Record<string, unknown>

function window(label: string, scope: QuotaWindow['scope'], value: unknown): QuotaWindow | null {
  const block = value as Json | null
  const used = num(block?.utilization)
  if (used === null) {
    return null
  }
  return { label, scope, usedPercent: clampPercent(used), resetsAt: toEpochMs(block?.resets_at) }
}

export function parseClaudeUsage(data: Json): QuotaWindow[] {
  const windows: (QuotaWindow | null)[] = [
    window('5h', 'account', data.five_hour),
    window('Weekly', 'account', data.seven_day)
  ]
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('seven_day_')) {
      windows.push(window(`Weekly ${key.slice('seven_day_'.length).replace(/_/g, ' ')}`, 'model', value))
    }
  }
  // Model-scoped weekly limits (e.g. one model's own cap) arrive in `limits`.
  for (const limit of Array.isArray(data.limits) ? (data.limits as Json[]) : []) {
    const model = (limit?.scope as Json | undefined)?.model as Json | undefined
    const name = typeof model?.display_name === 'string' ? model.display_name : null
    if (limit?.kind === 'weekly_scoped' && name) {
      windows.push(
        window(`Weekly ${name}`, 'model', { utilization: limit.percent, resets_at: limit.resets_at })
      )
    }
  }
  const extra = data.extra_usage as Json | null | undefined
  if (extra?.is_enabled === true) {
    windows.push(window('Extra usage', 'model', extra))
  }
  return windows.filter((entry): entry is QuotaWindow => entry !== null)
}

export async function fetchClaude(cred: OAuthCred): Promise<QuotaAccount> {
  const base = {
    provider: 'Claude',
    source: cred.source,
    account: cred.account ?? cred.source,
    plan: cred.plan
  }
  if (isExpired(cred)) {
    return expiredAccount(base, cred.source === 'Claude Code' ? 'claude' : cred.source)
  }
  return settle(base, async () => {
    const data = (await getJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${cred.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0'
    })) as Json
    return { windows: parseClaudeUsage(data) }
  })
}
