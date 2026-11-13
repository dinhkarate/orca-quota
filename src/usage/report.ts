// Turns the index's buckets into what the panel and the status bar show.
import { formatTokens, formatUsd } from '../format'
import type { UsagePoint, UsageRange, UsageReport, UsageRow, UsageTotals } from '../protocol'
import type { Tone } from '../summary'
import { priceFor, type PriceTable } from './pricing'
import { dayKey, type Totals } from './scanner'

const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = { today: 1, '7d': 7, '30d': 30 }
const MAX_MONTHS = 24

function daysBack(now: Date, days: number): string[] {
  const keys: string[] = []
  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(now)
    day.setDate(day.getDate() - back)
    keys.push(dayKey(day.getTime()))
  }
  return keys
}

function monthsUpTo(first: string, last: string): string[] {
  const months: string[] = []
  let [year, month] = first.split('-').map(Number)
  const [endYear, endMonth] = last.split('-').map(Number)
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month = month === 12 ? 1 : month + 1
    year = month === 1 ? year + 1 : year
  }
  return months.slice(-MAX_MONTHS)
}

/** The last two folders of a working directory, e.g. `orca-quota/main`. */
export function projectLabel(cwd: string, home: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return 'Unknown'
  }
  if (trimmed === home) {
    return '~'
  }
  return trimmed.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

const emptyTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  calls: 0,
  tokens: 0,
  cost: 0,
  unpriced: 0
})

export function buildReport(
  buckets: Map<string, Totals>,
  prices: PriceTable,
  range: UsageRange,
  options: { home: string; scanning: UsageReport['scanning']; updatedAt: number; now?: Date }
): UsageReport {
  const now = options.now ?? new Date()
  const days = range === 'all' ? null : daysBack(now, RANGE_DAYS[range])
  const inRange = days ? new Set(days) : null
  const totals = emptyTotals()
  const groups = { agents: new Map<string, UsageRow>(), models: new Map<string, UsageRow>(), projects: new Map<string, UsageRow>() }
  const series = new Map<string, UsagePoint>()
  let firstMonth: string | null = null

  for (const [key, bucket] of buckets) {
    const [agent, day, model, cwd, kind] = key.split('\t')
    if (inRange && !inRange.has(day)) {
      continue
    }
    const tokens = bucket[0] + bucket[1] + bucket[2] + bucket[3]
    const price = kind === 'L' ? null : priceFor(prices, model)
    const cost =
      kind === 'L'
        ? bucket[6]
        : price
          ? bucket[0] * price[0] + bucket[1] * price[1] + bucket[2] * price[2] + bucket[3] * price[3]
          : 0
    const unpriced = kind !== 'L' && !price ? tokens : 0

    totals.input += bucket[0]
    totals.output += bucket[1]
    totals.cacheRead += bucket[2]
    totals.cacheWrite += bucket[3]
    totals.reasoning += bucket[4]
    totals.calls += bucket[5]
    totals.tokens += tokens
    totals.cost += cost
    totals.unpriced += unpriced

    const add = (group: Map<string, UsageRow>, rowKey: string, label: string): void => {
      const row = group.get(rowKey) ?? { key: rowKey, label, tokens: 0, cost: 0, calls: 0, unpriced: 0 }
      row.tokens += tokens
      row.cost += cost
      row.calls += bucket[5]
      row.unpriced += unpriced
      group.set(rowKey, row)
    }
    add(groups.agents, agent, agent)
    add(groups.models, model, model)
    add(groups.projects, cwd, projectLabel(cwd, options.home))

    const pointKey = range === 'all' ? day.slice(0, 7) : day
    const point = series.get(pointKey) ?? { label: pointKey, tokens: 0, cost: 0 }
    point.tokens += tokens
    point.cost += cost
    series.set(pointKey, point)
    if (range === 'all' && (!firstMonth || pointKey < firstMonth)) {
      firstMonth = pointKey
    }
  }

  const sorted = (group: Map<string, UsageRow>): UsageRow[] =>
    [...group.values()].sort((a, b) => b.tokens - a.tokens)
  const labels =
    range === 'today' ? [] : (days ?? (firstMonth ? monthsUpTo(firstMonth, dayKey(now.getTime()).slice(0, 7)) : []))
  return {
    range,
    totals,
    agents: sorted(groups.agents),
    models: sorted(groups.models),
    projects: sorted(groups.projects),
    series: labels.map((label) => series.get(label) ?? { label, tokens: 0, cost: 0 }),
    scanning: options.scanning,
    updatedAt: options.updatedAt
  }
}

/** Orca refuses a status bar update whose tooltip is longer, and shows it on one line. */
const TOOLTIP_MAX = 256

/** Today's tokens and cost; a quota running low adds itself and sets the tone. */
export function usageStatusBar(
  today: UsageReport,
  quota: { text: string; tone: Tone } | null
): { text: string; tone: Tone; tooltip: string } {
  const { totals } = today
  const head =
    totals.calls > 0
      ? `${formatTokens(totals.tokens)} · ${formatUsd(totals.cost)}`
      : today.scanning
        ? 'Reading logs…'
        : 'No tokens today'
  const parts = [
    totals.calls > 0
      ? `Today: ${formatTokens(totals.tokens)} tokens, ≈ ${formatUsd(totals.cost)}`
      : 'Today: no tokens yet',
    today.agents.map((row) => `${row.label} ${formatTokens(row.tokens)}`).join(', '),
    totals.unpriced > 0 ? `${formatTokens(totals.unpriced)} unpriced` : '',
    today.scanning?.total ? `reading logs ${today.scanning.done}/${today.scanning.total}` : '',
    // statusBarState names a provider only when one reports a limit.
    quota && quota.text !== 'Quota' ? `lowest quota: ${quota.text} left` : ''
  ]
  const tooltip = parts.filter(Boolean).join(' · ')
  const warn = quota && quota.tone !== 'neutral'
  return {
    text: warn ? `${head} · ${quota.text}` : head,
    tone: quota?.tone ?? 'neutral',
    tooltip: tooltip.length > TOOLTIP_MAX ? `${tooltip.slice(0, TOOLTIP_MAX - 1)}…` : tooltip
  }
}
