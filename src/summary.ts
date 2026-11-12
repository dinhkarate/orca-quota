// How much is left per provider, for the status bar and the panel's group headers.
import type { QuotaAccount, QuotaSnapshot, QuotaWindow } from './protocol'

export type Headroom = { remaining: number; window: QuotaWindow }

export type ProviderSummary = {
  provider: string
  /** The best account's headroom: in a pool the router moves to whichever account has room. */
  best: Headroom | null
  accounts: number
  errors: number
}

/** An account can send requests while every account-wide window has room, so its headroom is
 *  the tightest of those. With only per-model windows, it is the roomiest model. */
export function accountHeadroom(account: QuotaAccount): Headroom | null {
  if (account.error) {
    return null
  }
  const measured = account.windows.filter((window) => window.usedPercent !== null)
  const accountWide = measured.filter((window) => window.scope === 'account')
  const pool = accountWide.length > 0 ? accountWide : measured
  if (pool.length === 0) {
    return null
  }
  const mostUsedFirst = [...pool].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))
  const window = accountWide.length > 0 ? mostUsedFirst[0] : mostUsedFirst[mostUsedFirst.length - 1]
  return { remaining: 100 - (window.usedPercent ?? 0), window }
}

export function summarize(snapshot: QuotaSnapshot): ProviderSummary[] {
  const byProvider = new Map<string, ProviderSummary>()
  for (const account of snapshot.accounts) {
    const summary = byProvider.get(account.provider) ?? {
      provider: account.provider,
      best: null,
      accounts: 0,
      errors: 0
    }
    summary.accounts++
    if (account.error) {
      summary.errors++
    }
    const headroom = accountHeadroom(account)
    if (headroom && (!summary.best || headroom.remaining > summary.best.remaining)) {
      summary.best = headroom
    }
    byProvider.set(account.provider, summary)
  }
  return [...byProvider.values()]
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger'

export function toneFor(remaining: number): Tone {
  return remaining < 10 ? 'danger' : remaining < 25 ? 'warning' : 'neutral'
}

function resetText(at: number | null, now: Date): string {
  if (at === null) {
    return ''
  }
  const date = new Date(at)
  const sameDay = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `, resets ${sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`}`
}

/** The status bar shows the provider closest to running out; the tooltip lists every one. */
export function statusBarState(
  summaries: ProviderSummary[],
  ignored: string[],
  now = new Date()
): { text: string; tone: Tone; tooltip: string } {
  const skip = new Set(ignored.map((name) => name.trim().toLowerCase()).filter(Boolean))
  const shown = summaries.filter((summary) => !skip.has(summary.provider.toLowerCase()))
  const measured = shown.filter((summary) => summary.best !== null)
  const lines = shown.map((summary) => {
    const pool = summary.accounts > 1 ? ` (best of ${summary.accounts})` : ''
    const errors = summary.errors > 0 ? `, ${summary.errors} failing` : ''
    return summary.best
      ? `${summary.provider}: ${Math.round(summary.best.remaining)}% left${pool}${resetText(summary.best.window.resetsAt, now)}${errors}`
      : `${summary.provider}: no limit data${errors}`
  })
  const tooltip = lines.length > 0 ? lines.join('\n') : 'No quota sources found yet'
  if (measured.length === 0) {
    return { text: 'Quota', tone: 'neutral', tooltip }
  }
  const worst = measured.reduce((low, next) => (next.best!.remaining < low.best!.remaining ? next : low))
  const remaining = worst.best!.remaining
  return { text: `${worst.provider} ${Math.round(remaining)}%`, tone: toneFor(remaining), tooltip }
}
