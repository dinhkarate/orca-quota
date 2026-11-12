// DeepSeek API balance: GET api.deepseek.com/user/balance.
import type { KeyCred } from '../credentials'
import { getJson, num } from '../http'
import type { QuotaAccount } from '../protocol'
import { settle } from './account'

type Json = Record<string, unknown>

const SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥' }

export function parseDeepSeekBalance(data: Json): { windows: []; balance?: string; error?: string } {
  const parts: string[] = []
  for (const info of Array.isArray(data.balance_infos) ? (data.balance_infos as Json[]) : []) {
    const total = num(info?.total_balance)
    const currency = String(info?.currency ?? '')
    if (total !== null) {
      parts.push(
        SYMBOLS[currency] ? `${SYMBOLS[currency]}${total.toFixed(2)}` : `${total.toFixed(2)} ${currency}`
      )
    }
  }
  return {
    windows: [],
    balance: parts.length > 0 ? `${parts.join(' + ')} left` : undefined,
    error: data.is_available === false ? 'balance too low to make requests' : undefined
  }
}

export async function fetchDeepSeek(cred: KeyCred): Promise<QuotaAccount> {
  const base = { provider: 'DeepSeek', source: cred.source, account: `…${cred.key.slice(-4)}` }
  return settle(base, async () =>
    parseDeepSeekBalance(
      (await getJson('https://api.deepseek.com/user/balance', {
        Authorization: `Bearer ${cred.key}`
      })) as Json
    )
  )
}
