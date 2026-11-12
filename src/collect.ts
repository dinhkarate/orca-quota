// One pass over every enabled source: find credentials, fetch each account's quota in parallel.
import {
  apiKeys,
  claudeCreds,
  codexCreds,
  copilotCreds,
  dedupe,
  grokCreds,
  nineRouterOrigins,
  readAgentConfigs,
  type AgentConfig,
  type OAuthCred
} from './credentials'
import { errorText } from './http'
import type { QuotaAccount, QuotaSnapshot } from './protocol'
import { fetchClaude } from './providers/claude'
import { fetchCodex } from './providers/codex'
import { fetchCopilot } from './providers/copilot'
import { fetchDeepSeek } from './providers/deepseek'
import { fetchGrok } from './providers/grok'
import { fetchNineRouter } from './providers/ninerouter'
import { fetchOpenRouter } from './providers/openrouter'

export type QuotaSettings = {
  claude: boolean
  codex: boolean
  grok: boolean
  copilot: boolean
  openrouter: boolean
  deepseek: boolean
  readAgentConfigs: boolean
  /** Empty: use the 9router that pi or omp point at, if any. */
  nineRouterUrl: string
}

export type QuotaSecrets = {
  nineRouterToken: string | null
  openRouterKey: string | null
  deepSeekKey: string | null
}

type Source = { name: string; run: () => Promise<QuotaAccount[]> }

function oauthSource(
  name: string,
  enabled: boolean,
  find: () => Promise<OAuthCred[]>,
  fetchOne: (cred: OAuthCred) => Promise<QuotaAccount>,
  notes: string[]
): Source | null {
  if (!enabled) {
    return null
  }
  return {
    name,
    run: async () => {
      const creds = dedupe(await find(), (cred) => cred.token)
      if (creds.length === 0) {
        notes.push(`${name}: not signed in`)
      }
      return Promise.all(creds.map(fetchOne))
    }
  }
}

export async function collectQuotas(settings: QuotaSettings, secrets: QuotaSecrets): Promise<QuotaSnapshot> {
  const notes: string[] = []
  const configs: AgentConfig[] = settings.readAgentConfigs ? await readAgentConfigs() : []
  const sources: (Source | null)[] = [
    oauthSource('Claude', settings.claude, () => claudeCreds(configs), fetchClaude, notes),
    oauthSource('Codex', settings.codex, () => codexCreds(configs), fetchCodex, notes),
    oauthSource('Grok', settings.grok, () => grokCreds(configs), fetchGrok, notes),
    oauthSource('Copilot', settings.copilot, () => copilotCreds(configs), fetchCopilot, notes)
  ]
  if (settings.openrouter) {
    const keys = apiKeys(configs, {
      secret: secrets.openRouterKey,
      env: 'OPENROUTER_API_KEY',
      authIds: ['openrouter'],
      host: 'openrouter.ai'
    })
    if (keys.length === 0) {
      notes.push('OpenRouter: no API key')
    }
    sources.push({ name: 'OpenRouter', run: () => Promise.all(keys.map(fetchOpenRouter)) })
  }
  if (settings.deepseek) {
    const keys = apiKeys(configs, {
      secret: secrets.deepSeekKey,
      env: 'DEEPSEEK_API_KEY',
      authIds: ['deepseek'],
      host: 'api.deepseek.com'
    })
    if (keys.length === 0) {
      notes.push('DeepSeek: no API key')
    }
    sources.push({ name: 'DeepSeek', run: () => Promise.all(keys.map(fetchDeepSeek)) })
  }
  const origins = settings.nineRouterUrl.trim()
    ? [new URL(settings.nineRouterUrl.trim()).origin]
    : nineRouterOrigins(configs)
  const nineRouterToken = secrets.nineRouterToken ?? process.env.NINE_ROUTER_CLI_TOKEN ?? null
  for (const origin of origins) {
    if (!nineRouterToken) {
      notes.push(`9router at ${origin}: add its CLI token under Keys`)
      continue
    }
    sources.push({
      name: `9router ${origin}`,
      run: async () => {
        const { accounts, withoutUsage } = await fetchNineRouter(origin, nineRouterToken)
        if (withoutUsage > 0) {
          notes.push(`9router: ${withoutUsage} connections have no usage API`)
        }
        return accounts
      }
    })
  }

  const results = await Promise.all(
    sources
      .filter((source): source is Source => source !== null)
      .map(async (source) => {
        try {
          return await source.run()
        } catch (error) {
          notes.push(`${source.name}: ${errorText(error)}`)
          return []
        }
      })
  )
  return { accounts: results.flat(), notes, updatedAt: Date.now() }
}
