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
  }
  interface PluginPanelEvents {
    'quota.updated': QuotaSnapshot
  }
}
