// Finds credentials the agents on this machine already keep. Read only: a token is never
// refreshed here, because refreshing rotates it and can sign the agent's own CLI out.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toEpochMs } from './http'

export type OAuthCred = {
  token: string
  source: string
  expiresAt: number | null
  account?: string
  /** ChatGPT workspace id for Codex. */
  accountId?: string
  plan?: string
  userId?: string
}

export type KeyCred = { key: string; source: string }

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

async function readJson(path: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim()))
  })
}

/** The payload of a JWT, without verifying it: only to read expiry, email and workspace id. */
export function jwtClaims(token: string): Json | null {
  const part = token.split('.')[1]
  if (!part) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const home = (): string => homedir()

// ---- pi and omp ------------------------------------------------------------------------------

export type AgentConfig = { source: string; auth: Json; providers: { baseUrl: string; apiKey: string }[] }

function agentDirs(): { source: string; dir: string }[] {
  return [
    { source: 'pi', dir: process.env.PI_CODING_AGENT_DIR || join(home(), '.pi', 'agent') },
    { source: 'omp', dir: join(home(), '.omp', 'agent') }
  ]
}

/** auth.json and models.json of pi and omp (omp's models.yml is YAML and is not read). */
export async function readAgentConfigs(): Promise<AgentConfig[]> {
  const configs: AgentConfig[] = []
  for (const { source, dir } of agentDirs()) {
    const auth = (await readJson(join(dir, 'auth.json'))) ?? {}
    const models = await readJson(join(dir, 'models.json'))
    const providers: AgentConfig['providers'] = []
    if (isObject(models?.providers)) {
      for (const provider of Object.values(models.providers)) {
        const baseUrl = isObject(provider) ? str(provider.baseUrl) : undefined
        const apiKey = isObject(provider) ? str(provider.apiKey) : undefined
        if (baseUrl && apiKey) {
          providers.push({ baseUrl, apiKey })
        }
      }
    }
    if (Object.keys(auth).length > 0 || providers.length > 0) {
      configs.push({ source, auth, providers })
    }
  }
  return configs
}

/** A key in models.json or auth.json: an env var name (`$NAME` or `NAME`, also looked up in auth.json, where
 *  pi keeps named secrets), a literal key, or a `!command`, which is never run. */
function resolveKeyRef(value: string, auth: Json): string | undefined {
  if (value.startsWith('!')) {
    return undefined
  }
  const name = /^\$?\{?([A-Z][A-Z0-9_]*)\}?$/.exec(value)?.[1]
  if (!name) {
    return value
  }
  const entry = auth[name]
  return str(process.env[name]) ?? (isObject(entry) ? str(entry.key) : undefined)
}

function agentOAuth(configs: AgentConfig[], providerId: string): (OAuthCred & { raw: Json })[] {
  const creds: (OAuthCred & { raw: Json })[] = []
  for (const { source, auth } of configs) {
    const entry = auth[providerId]
    const token = isObject(entry) && entry.type === 'oauth' ? str(entry.access) : undefined
    if (isObject(entry) && token) {
      creds.push({ token, source, expiresAt: toEpochMs(entry.expires), raw: entry })
    }
  }
  return creds
}

// ---- subscriptions -----------------------------------------------------------------------------

export async function claudeCreds(configs: AgentConfig[]): Promise<OAuthCred[]> {
  const creds: OAuthCred[] = []
  const fromBlob = (blob: Json | null, source: string): void => {
    const oauth = isObject(blob?.claudeAiOauth) ? blob.claudeAiOauth : null
    const token = str(oauth?.accessToken)
    if (oauth && token) {
      creds.push({ token, source, expiresAt: toEpochMs(oauth.expiresAt), plan: str(oauth.subscriptionType) })
    }
  }
  if (process.platform === 'darwin') {
    const raw = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
    try {
      fromBlob(raw ? (JSON.parse(raw) as Json) : null, 'Claude Code')
    } catch {
      // Not JSON: an older Claude Code format; the file below may still have it.
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home(), '.claude')
  fromBlob(await readJson(join(configDir, '.credentials.json')), 'Claude Code')
  creds.push(...agentOAuth(configs, 'anthropic'))
  return creds
}

export async function codexCreds(configs: AgentConfig[]): Promise<OAuthCred[]> {
  const creds: OAuthCred[] = []
  const auth = await readJson(join(process.env.CODEX_HOME || join(home(), '.codex'), 'auth.json'))
  const tokens = isObject(auth?.tokens) ? auth.tokens : null
  const token = str(tokens?.access_token)
  if (tokens && token) {
    const idClaims = jwtClaims(str(tokens.id_token) ?? '')
    creds.push({
      token,
      source: 'Codex',
      expiresAt: toEpochMs(jwtClaims(token)?.exp),
      accountId: str(tokens.account_id),
      account: str(idClaims?.email)
    })
  }
  for (const cred of agentOAuth(configs, 'openai-codex')) {
    const claims = jwtClaims(cred.token)
    const openai = isObject(claims?.['https://api.openai.com/auth'])
      ? claims['https://api.openai.com/auth']
      : null
    const profile = isObject(claims?.['https://api.openai.com/profile'])
      ? claims['https://api.openai.com/profile']
      : null
    creds.push({
      ...cred,
      accountId: str(cred.raw.accountId) ?? str(openai?.chatgpt_account_id),
      account: str(profile?.email)
    })
  }
  return creds
}

export async function grokCreds(configs: AgentConfig[]): Promise<OAuthCred[]> {
  const creds: OAuthCred[] = []
  const auth = await readJson(join(process.env.GROK_HOME || join(home(), '.grok'), 'auth.json'))
  for (const entry of Object.values(auth ?? {})) {
    const token = isObject(entry) ? str(entry.key) : undefined
    if (isObject(entry) && token) {
      creds.push({
        token,
        source: 'Grok CLI',
        expiresAt: toEpochMs(entry.expires_at),
        account: str(entry.email),
        userId: str(entry.user_id)
      })
    }
  }
  creds.push(...agentOAuth(configs, 'xai'))
  return creds
}

/** GitHub OAuth tokens that can read Copilot quota: `gh auth token`, and pi's Copilot login. */
export async function copilotCreds(configs: AgentConfig[]): Promise<OAuthCred[]> {
  const creds: OAuthCred[] = []
  for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    const token = await run(gh, ['auth', 'token'])
    if (token) {
      creds.push({ token, source: 'gh', expiresAt: null })
      break
    }
  }
  for (const { source, auth } of configs) {
    const entry = auth['github-copilot']
    const token = isObject(entry) ? str(entry.refresh) : undefined
    if (token) {
      creds.push({ token, source, expiresAt: null })
    }
  }
  return creds
}

// ---- API keys ----------------------------------------------------------------------------------

/** Keys for one API: the plugin's own secret, an env var, pi/omp auth.json entries, and pi/omp
 *  models.json providers whose base URL is on `host`. */
export function apiKeys(
  configs: AgentConfig[],
  options: { secret: string | null; env: string; authIds: string[]; host: string }
): KeyCred[] {
  const keys: KeyCred[] = []
  if (options.secret) {
    keys.push({ key: options.secret, source: 'Orca' })
  }
  const fromEnv = str(process.env[options.env])
  if (fromEnv) {
    keys.push({ key: fromEnv, source: 'env' })
  }
  for (const { source, auth, providers } of configs) {
    for (const id of [...options.authIds, options.env]) {
      const entry = auth[id]
      const raw = isObject(entry) ? str(entry.key) : undefined
      const key = raw ? resolveKeyRef(raw, auth) : undefined
      if (key) {
        keys.push({ key, source })
      }
    }
    for (const provider of providers) {
      let host = ''
      try {
        host = new URL(provider.baseUrl).hostname
      } catch {
        continue
      }
      const key = host === options.host ? resolveKeyRef(provider.apiKey, auth) : undefined
      if (key) {
        keys.push({ key, source })
      }
    }
  }
  return dedupe(keys, (cred) => cred.key)
}

/** 9router base URLs that pi or omp send requests to (a provider whose host names 9router). */
export function nineRouterOrigins(configs: AgentConfig[]): string[] {
  const origins = new Set<string>()
  for (const { providers } of configs) {
    for (const provider of providers) {
      try {
        const url = new URL(provider.baseUrl)
        if (url.hostname.includes('9router')) {
          origins.add(url.origin)
        }
      } catch {
        // Not a URL.
      }
    }
  }
  return [...origins]
}

/** First of each value wins, so the source listed first names a shared credential. */
export function dedupe<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyOf(item)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}
