// Every account in a 9router pool: GET /api/providers, then /api/usage/<connection>, which 9router
// answers with quotas it already normalized. Authenticated with 9router's CLI token header.
import { clampPercent, errorText, getJson, num, toEpochMs } from '../http'
import type { QuotaAccount, QuotaWindow } from '../protocol'
import { accountKey } from './account'

type Json = Record<string, unknown>

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  'gemini-cli': 'Gemini CLI',
  github: 'Copilot',
  'grok-cli': 'Grok',
  xai: 'Grok',
  kiro: 'Kiro',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder',
  cursor: 'Cursor',
  glm: 'Z.ai GLM',
  'glm-cn': 'Z.ai GLM',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  'opencode-go': 'OpenCode Go',
  'opencode-zen': 'OpenCode Zen'
}

// Per-model quotas: one exhausted model does not stop the account.
const MODEL_SCOPED_PROVIDERS = new Set(['antigravity', 'gemini-cli'])
const CONCURRENCY = 4

/** A message 9router sends instead of quotas when the provider has no usage API at all. */
const NO_USAGE_API = /not (implemented|available)/i

function prettyLabel(name: string): string {
  const label = name
    .replace(/^session \(5h\)$/i, '5h')
    .replace(/^weekly \(7d\)$/i, 'Weekly')
    .replace(/_/g, ' ')
  return label[0].toUpperCase() + label.slice(1)
}

export function parseNineRouterUsage(
  provider: string,
  usage: Json
): Pick<QuotaAccount, 'windows' | 'plan' | 'balance' | 'error'> | null {
  const quotas = (usage.quotas ?? null) as Record<string, Json> | null
  if (!quotas || typeof quotas !== 'object') {
    const message = typeof usage.message === 'string' ? usage.message : 'no usage data'
    return NO_USAGE_API.test(message) ? null : { windows: [], error: message }
  }
  const windows: QuotaWindow[] = []
  const balances: string[] = []
  for (const [name, quota] of Object.entries(quotas)) {
    if (!quota || quota.unlimited === true) {
      continue
    }
    const total = num(quota.total)
    if (quota.isCreditBalance === true) {
      balances.push(`${(total ?? 0).toFixed(2)} ${String(quota.currency ?? '')}`.trim())
      continue
    }
    const remainingPercent = num(quota.remainingPercentage)
    const used = num(quota.used)
    const usedPercent =
      remainingPercent !== null
        ? 100 - remainingPercent
        : used !== null && total !== null && total > 0
          ? (used / total) * 100
          : null
    if (usedPercent === null) {
      continue
    }
    const modelScoped =
      MODEL_SCOPED_PROVIDERS.has(provider) || /review|spark/i.test(name) || /^weekly \w+ \(7d\)$/i.test(name)
    windows.push({
      label: typeof quota.displayName === 'string' ? quota.displayName : prettyLabel(name),
      scope: modelScoped ? 'model' : 'account',
      usedPercent: clampPercent(usedPercent),
      resetsAt: toEpochMs(quota.resetAt)
    })
  }
  return {
    windows,
    plan: typeof usage.plan === 'string' ? usage.plan : undefined,
    balance: balances.length > 0 ? `${balances.join(' + ')} left` : undefined
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Accounts of every active connection, and how many connections have no usage API. */
export async function fetchNineRouter(
  origin: string,
  token: string
): Promise<{ accounts: QuotaAccount[]; withoutUsage: number }> {
  const headers = { 'x-9r-cli-token': token }
  const host = new URL(origin).host
  const body = (await getJson(`${origin}/api/providers`, headers)) as Json
  const connections = (Array.isArray(body.connections) ? body.connections : []) as Json[]
  let withoutUsage = 0
  const accounts = await mapLimited(
    connections.filter((connection) => connection.isActive !== false && typeof connection.id === 'string'),
    CONCURRENCY,
    async (connection): Promise<QuotaAccount | null> => {
      const provider = String(connection.provider ?? '')
      const name = [connection.displayName, connection.email, connection.name].find(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
      const base = {
        provider: PROVIDER_LABELS[provider] ?? provider,
        source: `9router ${host}`,
        account: name ?? String(connection.id).slice(0, 8)
      }
      const key = accountKey(base.provider, base.source, String(connection.id))
      try {
        const usage = (await getJson(
          `${origin}/api/usage/${encodeURIComponent(String(connection.id))}`,
          headers
        )) as Json
        const parsed = parseNineRouterUsage(provider, usage)
        if (!parsed) {
          withoutUsage++
          return null
        }
        return { ...base, key, ...parsed }
      } catch (error) {
        return { ...base, key, windows: [], error: errorText(error) }
      }
    }
  )
  return { accounts: accounts.filter((account): account is QuotaAccount => account !== null), withoutUsage }
}
