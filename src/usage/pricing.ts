// API list prices per token, from LiteLLM's public price table (MIT), fetched at most once a day.
// Subscription plans do not bill per token, so a cost from this table is what the same tokens
// would cost on the API.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getJson } from '../http'

/** USD per token: input, output, cache read, cache write. */
export type Price = [number, number, number, number]
export type PriceTable = Record<string, Price>

const PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const PREFIXES = ['', 'anthropic/', 'openai/', 'xai/', 'deepseek/', 'gemini/', 'moonshot/', 'openrouter/']

type Json = Record<string, unknown>
type CacheFile = { fetchedAt: number; table: PriceTable }

const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Keeps the base per-token prices of every model that has an input price. */
export function reducePrices(raw: Json): PriceTable {
  const table: PriceTable = {}
  for (const [model, value] of Object.entries(raw)) {
    const entry = typeof value === 'object' && value !== null ? (value as Json) : null
    const input = rate(entry?.input_cost_per_token)
    if (input === null) {
      continue
    }
    table[model.toLowerCase()] = [
      input,
      rate(entry?.output_cost_per_token) ?? 0,
      rate(entry?.cache_read_input_token_cost) ?? input,
      rate(entry?.cache_creation_input_token_cost) ?? input
    ]
  }
  return table
}

/** The table's price for a model name as an agent logs it (`oc/kimi-k2.6`, `claude-opus-4.6`). */
export function priceFor(table: PriceTable, model: string): Price | null {
  const name = model.toLowerCase()
  if (/[-:]free$/.test(name)) {
    return [0, 0, 0, 0]
  }
  const base = name.split('/').pop() ?? name
  const variants = new Set([
    name,
    base,
    base.replace(/(\d)\.(\d)/g, '$1-$2'),
    base.replace(/-\d{8}$/, '')
  ])
  for (const variant of variants) {
    for (const prefix of PREFIXES) {
      const price = table[prefix + variant]
      if (price) {
        return price
      }
    }
  }
  return null
}

/** The cached table, fetched again when older than a day; the stale one if the fetch fails. */
export async function loadPrices(cachePath: string, fetchAllowed: boolean): Promise<PriceTable> {
  let cached: CacheFile | null = null
  try {
    cached = JSON.parse(await readFile(cachePath, 'utf8')) as CacheFile
  } catch {
    cached = null
  }
  if (!fetchAllowed || (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS)) {
    return cached?.table ?? {}
  }
  try {
    const table = reducePrices((await getJson(PRICES_URL, {})) as Json)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), table } satisfies CacheFile))
    return table
  } catch {
    return cached?.table ?? {}
  }
}
