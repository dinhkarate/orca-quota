// The Usage tab: tokens and cost over a range, by day and by agent, model or project.
import {
  atom,
  Box,
  Button,
  Callout,
  EmptyState,
  Grid,
  IconButton,
  KeyValue,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Tab,
  Table,
  Tabs,
  Text,
  Toolbar
} from 'orca'
import { formatTokens, formatUsd } from './format'
import type { UsagePoint, UsageRange, UsageReport, UsageRow } from './protocol'

const range = atom<UsageRange>('today')
const report = atom<UsageReport | null>(null)
const loading = atom(false)
const failure = atom<string | null>(null)
const groupBy = atom('agents')

const RANGES: { value: UsageRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' }
]

const CHART_HEIGHT = 84

export async function loadUsage(refresh = false): Promise<void> {
  set(loading, true)
  try {
    set(report, await plugin.request('usage.get', { range: read(range), refresh }, { timeoutMs: 120_000 }))
    set(failure, null)
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  } finally {
    set(loading, false)
  }
}

function choose(next: UsageRange): void {
  set(range, next)
  void loadUsage()
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Box border radius="md" padding="sm" gap="xs">
      <Text size="xs" muted>
        {label}
      </Text>
      <Text weight="semibold">{value}</Text>
      {detail ? (
        <Text size="xs" muted truncate>
          {detail}
        </Text>
      ) : null}
    </Box>
  )
}

/** `2026-11-13` → `Nov 13`; `2026-11` → `Nov 2026`. */
function pointLabel(label: string): string {
  const [year, month, day] = label.split('-').map(Number)
  const date = new Date(year, month - 1, day || 1)
  return day
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

function Chart({ points }: { points: UsagePoint[] }) {
  const peak = points.reduce((best, point) => (point.tokens > best.tokens ? point : best), points[0])
  return (
    <Stack gap="xs">
      <Box direction="row" align="end" gap="xs" height={CHART_HEIGHT}>
        {points.map((point) => (
          <Box
            grow
            radius="sm"
            background={point.tokens > 0 ? 'accent' : 'muted'}
            height={Math.max(2, Math.round((CHART_HEIGHT * point.tokens) / Math.max(1, peak.tokens)))}
          />
        ))}
      </Box>
      <Row justify="between" gap="sm">
        <Text size="xs" muted>
          {pointLabel(points[0].label)}
        </Text>
        {peak.tokens > 0 ? (
          <Text size="xs" muted truncate>
            Peak {pointLabel(peak.label)}: {formatTokens(peak.tokens)} · {formatUsd(peak.cost)}
          </Text>
        ) : null}
        <Text size="xs" muted>
          {pointLabel(points[points.length - 1].label)}
        </Text>
      </Row>
    </Stack>
  )
}

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'tokens', label: 'Tokens', align: 'end', width: 'sm' },
  { key: 'cost', label: 'Cost', align: 'end', width: 'sm' },
  { key: 'share', label: 'Share', align: 'end', width: 'xs', hideBelow: 'sm' }
] as const

function Breakdown({ label, rows, total }: { label: string; rows: UsageRow[]; total: number }) {
  return (
    <Table
      label={label}
      columns={COLUMNS}
      maxHeight="md"
      emptyText="Nothing in this range"
      rows={rows.map((row) => ({
        key: row.key || '(none)',
        cells: {
          name: row.label,
          tokens: formatTokens(row.tokens),
          // A row with tokens on unpriced models costs at least this much.
          cost: row.unpriced > 0 && row.cost === 0 ? 'no price' : `${formatUsd(row.cost)}${row.unpriced > 0 ? '+' : ''}`,
          share: `${total > 0 ? Math.round((row.tokens / total) * 100) : 0}%`
        }
      }))}
    />
  )
}

export function UsageView() {
  const current = read(report)
  const error = read(failure)
  const totals = current?.totals
  const scanning = current?.scanning
  return (
    <Stack gap="md">
      <Row justify="between" gap="sm">
        <Toolbar label="Range" gap="xs">
          {RANGES.map((option) => (
            <Button
              size="sm"
              variant={read(range) === option.value ? 'solid' : 'ghost'}
              onPress={() => choose(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </Toolbar>
        <Row gap="xs">
          {current?.updatedAt ? (
            <Text size="xs" muted>
              <RelativeTime at={current.updatedAt} format="short" />
            </Text>
          ) : null}
          <IconButton
            icon="refresh"
            label="Read new usage"
            disabled={read(loading)}
            onPress={() => loadUsage(true)}
          />
        </Row>
      </Row>
      {error ? (
        <Callout tone="danger" title="Could not read usage">
          {error}
        </Callout>
      ) : null}
      {scanning ? (
        <Stack gap="xs">
          <Progress
            label="Reading agent logs"
            labelHidden
            value={scanning.total > 0 ? (scanning.done / scanning.total) * 100 : 0}
          />
          <Text size="xs" muted>
            Reading agent logs{scanning.total > 0 ? `: ${scanning.done} of ${scanning.total} files` : '…'} The
            first read takes a minute or so; after that only new lines are read.
          </Text>
        </Stack>
      ) : null}
      {!current || !totals ? <Skeleton lines={4} label="Reading usage" /> : null}
      {current && totals && totals.calls === 0 && !scanning ? (
        <EmptyState
          icon="bar-chart-3"
          title="No tokens in this range"
          description="Usage shows up here once Claude Code, Codex, pi, omp, Grok, OpenCode, dsh or Antigravity answers a prompt."
        />
      ) : null}
      {current && totals && totals.calls > 0 ? (
        <Stack gap="md">
          <Grid columns={3} gap="sm">
            <Stat label="Tokens" value={formatTokens(totals.tokens)} detail={`${formatTokens(totals.cacheRead)} from cache`} />
            <Stat
              label="Cost"
              value={formatUsd(totals.cost)}
              detail={totals.unpriced > 0 ? `+ ${formatTokens(totals.unpriced)} unpriced` : 'API prices'}
            />
            <Stat label="Responses" value={totals.calls.toLocaleString('en-US')} />
          </Grid>
          {current.series.length > 1 ? <Chart points={current.series} /> : null}
          <KeyValue
            items={[
              { label: 'Input', value: formatTokens(totals.input) },
              {
                label: 'Output',
                value: `${formatTokens(totals.output)}${totals.reasoning > 0 ? ` (${formatTokens(totals.reasoning)} reasoning)` : ''}`
              },
              { label: 'Cache read', value: formatTokens(totals.cacheRead) },
              { label: 'Cache write', value: formatTokens(totals.cacheWrite) }
            ]}
          />
          <Tabs label="Break down by" value={read(groupBy)} onChange={(value) => set(groupBy, value)}>
            <Tab value="agents" label="Agents">
              <Breakdown label="Usage by agent" rows={current.agents} total={totals.tokens} />
            </Tab>
            <Tab value="models" label="Models">
              <Breakdown label="Usage by model" rows={current.models} total={totals.tokens} />
            </Tab>
            <Tab value="projects" label="Projects">
              <Breakdown label="Usage by project" rows={current.projects} total={totals.tokens} />
            </Tab>
          </Tabs>
          <Text size="xs" muted>
            pi, omp, Grok and OpenCode log what each response cost; the rest is priced at API list
            prices (LiteLLM). A subscription such as Claude Max or ChatGPT Pro does not bill per token,
            so for those this is what the same tokens would cost on the API.
          </Text>
        </Stack>
      ) : null}
    </Stack>
  )
}
