// GitHub Copilot premium requests and free-plan quotas: GET api.github.com/copilot_internal/user.
import type { OAuthCred } from '../credentials'
import { clampPercent, getJson, num, toEpochMs } from '../http'
import type { QuotaAccount, QuotaWindow } from '../protocol'
import { settle } from './account'

type Json = Record<string, unknown>

const LABELS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Completions'
}

export function parseCopilotUser(data: Json): { windows: QuotaWindow[]; plan?: string; account?: string } {
  const windows: QuotaWindow[] = []
  const snapshots = data.quota_snapshots as Record<string, Json> | undefined
  if (snapshots) {
    const resetsAt = toEpochMs(data.quota_reset_date)
    for (const [id, snapshot] of Object.entries(snapshots)) {
      const entitlement = num(snapshot?.entitlement)
      const remaining = num(snapshot?.remaining)
      const percentRemaining = num(snapshot?.percent_remaining)
      if (snapshot?.unlimited === true || entitlement === null || entitlement <= 0) {
        continue
      }
      const usedPercent =
        percentRemaining !== null
          ? 100 - percentRemaining
          : remaining !== null
            ? ((entitlement - remaining) / entitlement) * 100
            : null
      windows.push({
        label: LABELS[id] ?? id,
        scope: 'account',
        usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
        detail: remaining === null ? undefined : `${Math.round(remaining)} of ${entitlement} left`,
        resetsAt
      })
    }
  } else if (data.monthly_quotas) {
    // Free plan: `limited_user_quotas` counts what is left of `monthly_quotas`.
    const totals = data.monthly_quotas as Json
    const left = (data.limited_user_quotas ?? {}) as Json
    const resetsAt = toEpochMs(data.limited_user_reset_date)
    for (const [id, totalValue] of Object.entries(totals)) {
      const total = num(totalValue)
      const remaining = num(left[id])
      if (total === null || total <= 0 || remaining === null) {
        continue
      }
      windows.push({
        label: LABELS[id] ?? id,
        scope: 'account',
        usedPercent: clampPercent(((total - remaining) / total) * 100),
        detail: `${remaining} of ${total} left`,
        resetsAt
      })
    }
  }
  const plan = data.copilot_plan ?? data.access_type_sku
  return {
    windows,
    plan: typeof plan === 'string' ? plan : undefined,
    account: typeof data.login === 'string' ? data.login : undefined
  }
}

export async function fetchCopilot(cred: OAuthCred): Promise<QuotaAccount> {
  const base = { provider: 'Copilot', source: cred.source, account: cred.source }
  const account = await settle(base, async () =>
    parseCopilotUser(
      (await getJson('https://api.github.com/copilot_internal/user', {
        Authorization: `token ${cred.token}`,
        'X-GitHub-Api-Version': '2025-04-01',
        'User-Agent': 'GitHubCopilotChat/0.38.0',
        'Editor-Version': 'vscode/1.100.0',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7'
      })) as Json
    )
  )
  // A 404 means this GitHub account has no Copilot seat, not a broken source.
  return account.error === 'HTTP 404'
    ? { ...account, error: 'no Copilot subscription on this account' }
    : account
}
