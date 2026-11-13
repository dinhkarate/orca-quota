// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type QuotaWindow = {
  label: string
  /** 0–100, how much of the window is used; null when the provider reports only an amount. */
  usedPercent: number | null
  /** `account` windows gate every request (5h, weekly); `model` windows gate one model or feature. */
  scope: 'account' | 'model'
  /** Amounts behind the percent, e.g. "$8.49 of $10". */
  detail?: string
  resetsAt: number | null
}

export type QuotaAccount = {
  /** Stable id: provider, source and account. */
  key: string
  /** Group shown in the panel and status bar, e.g. "Claude", "Codex", "OpenRouter". */
  provider: string
  /** Email, key label or connection name. */
  account: string
  /** Where the credential came from: "Claude Code", "pi", "9router", "gh", ... */
  source: string
  plan?: string
  windows: QuotaWindow[]
  /** A credit balance, e.g. "$4.20 left". */
  balance?: string
  error?: string
}

export type QuotaSnapshot = {
  accounts: QuotaAccount[]
  /** Sources that were skipped or found nothing, one line each. */
  notes: string[]
  updatedAt: number
}

export type UsageRange = 'today' | '7d' | '30d' | 'all'

export type UsageTotals = {
  /** Input not served from cache. */
  input: number
  /** Output, reasoning included. */
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** Model responses. */
  calls: number
  /** input + output + cache read + cache write. */
  tokens: number
  /** USD: what the agent logged, else API list price. */
  cost: number
  /** Tokens of models with no logged cost and no list price; not in `cost`. */
  unpriced: number
}

export type UsageRow = { key: string; label: string; tokens: number; cost: number; calls: number; unpriced: number }

/** One bar: a day, or a month for `all`. */
export type UsagePoint = { label: string; tokens: number; cost: number }

export type UsageReport = {
  range: UsageRange
  totals: UsageTotals
  agents: UsageRow[]
  models: UsageRow[]
  projects: UsageRow[]
  series: UsagePoint[]
  /** Set while logs are being read: files read so far and in all. */
  scanning: { done: number; total: number } | null
  updatedAt: number
}

/** Plugin secrets the Keys section writes and the worker reads. */
export const SECRET_KEYS = {
  nineRouterToken: 'ninerouter.token',
  openRouterKey: 'openrouter.key',
  deepSeekKey: 'deepseek.key'
} as const

declare module 'orca' {
  interface PluginRequests {
    /** The last snapshot; `refresh` fetches every source again first. */
    'quota.get': { input: { refresh?: boolean }; output: QuotaSnapshot | null }
    /** Token usage over a range, from what the logs held at the last scan. */
    'usage.get': { input: { range: UsageRange; refresh?: boolean }; output: UsageReport }
  }
  interface PluginPanelEvents {
    'quota.updated': QuotaSnapshot
    /** New usage was read; panels ask again for their range. */
    'usage.updated': { updatedAt: number }
  }
}
