// fetch with a timeout and short, secret-free errors.

const TIMEOUT_MS = 15_000

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `unauthorized (HTTP ${status})` : `HTTP ${status}`)
  }
}

export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new HttpError(response.status)
  }
  return response.json()
}

export function errorText(error: unknown): string {
  if (error instanceof HttpError) {
    return error.message
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timed out'
  }
  return error instanceof Error ? error.message : String(error)
}

export function num(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

/** Seconds, milliseconds or an ISO string to epoch ms. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value) {
    if (/^\d+$/.test(value)) {
      return toEpochMs(Number(value))
    }
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

export const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

export const usd = (value: number): string => `$${value.toFixed(2)}`
