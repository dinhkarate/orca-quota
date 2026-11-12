// Helpers every provider uses to turn a credential into a QuotaAccount.
import type { OAuthCred } from '../credentials'
import { errorText } from '../http'
import type { QuotaAccount } from '../protocol'

export function accountKey(provider: string, source: string, account: string): string {
  return `${provider}\u0000${source}\u0000${account}`
}

/** An expired OAuth token is reported, not refreshed: the agent refreshes it on its next run. */
export function isExpired(cred: OAuthCred, now = Date.now()): boolean {
  return cred.expiresAt !== null && cred.expiresAt <= now
}

/** Runs one fetch and folds a throw into the account's `error`, so one bad source never hides
 *  the others. */
export async function settle(
  base: Omit<QuotaAccount, 'key' | 'windows'>,
  fetchAccount: () => Promise<Partial<QuotaAccount>>
): Promise<QuotaAccount> {
  const key = accountKey(base.provider, base.source, base.account)
  try {
    const found = await fetchAccount()
    return { ...base, windows: [], ...found, key }
  } catch (error) {
    return { ...base, key, windows: [], error: errorText(error) }
  }
}

export function expiredAccount(base: Omit<QuotaAccount, 'key' | 'windows'>, agent: string): QuotaAccount {
  return {
    ...base,
    key: accountKey(base.provider, base.source, base.account),
    windows: [],
    error: `sign-in expired: run ${agent} once to refresh it`
  }
}
