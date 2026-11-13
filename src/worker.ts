// The plugin's worker. Orca keeps it running while the plugin is enabled (it owns a status bar
// item). Every minute it reads what the agents logged since the last read and adds up the tokens;
// on its own, slower timer it polls each provider's quota and keeps that snapshot in
// orca.storage. Both feed the status bar and open panels.
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { collectQuotas, type QuotaSecrets, type QuotaSettings } from './collect'
import { SECRET_KEYS, type QuotaSnapshot, type UsageRange, type UsageReport } from './protocol'
import { statusBarState, summarize } from './summary'
import { loadPrices, type PriceTable } from './usage/pricing'
import { buildReport, usageStatusBar } from './usage/report'
import { UsageIndex } from './usage/scanner'
import { lineSources, wholeSources } from './usage/sources'

const SNAPSHOT_KEY = 'snapshot:v1'
const STATUS_ITEM = 'usage'
const USAGE_EVERY_MS = 60_000
const PRICES_EVERY_MS = 60 * 60_000
const PROGRESS_EVERY_MS = 2_000

let quotaTimer: ReturnType<typeof setTimeout> | null = null
let usageTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false

/** The index and price cache live outside Orca's plugin storage, which is too small for them. */
const dataDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'orca-agent-usage')

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  let snapshot: QuotaSnapshot | null = null
  let running: Promise<QuotaSnapshot> | null = null
  const dir = dataDir()
  const index = new UsageIndex(join(dir, 'usage-index.json'), lineSources(), wholeSources())
  let prices: PriceTable = {}
  let pricesAt = 0
  let scanning: UsageReport['scanning'] = null
  let scanned: Promise<void> | null = null
  let usageUpdatedAt = 0

  async function readSettings(): Promise<
    QuotaSettings & { refreshMinutes: number; statusBarIgnore: string; fetchPrices: boolean }
  > {
    const all = await orca.settings.get()
    const flag = (key: string): boolean => all[key] !== false
    return {
      claude: flag('claude'),
      codex: flag('codex'),
      grok: flag('grok'),
      copilot: flag('copilot'),
      openrouter: flag('openrouter'),
      deepseek: flag('deepseek'),
      readAgentConfigs: flag('readAgentConfigs'),
      fetchPrices: flag('fetchPrices'),
      nineRouterUrl: typeof all.nineRouterUrl === 'string' ? all.nineRouterUrl : '',
      refreshMinutes: typeof all.refreshMinutes === 'number' ? all.refreshMinutes : 5,
      statusBarIgnore: typeof all.statusBarIgnore === 'string' ? all.statusBarIgnore : ''
    }
  }

  async function readSecrets(): Promise<QuotaSecrets> {
    return {
      nineRouterToken: await orca.secrets.get(SECRET_KEYS.nineRouterToken),
      openRouterKey: await orca.secrets.get(SECRET_KEYS.openRouterKey),
      deepSeekKey: await orca.secrets.get(SECRET_KEYS.deepSeekKey)
    }
  }

  function report(range: UsageRange): UsageReport {
    // Until the first scan ends, the totals may be missing whole agents.
    const progress = scanning ?? (usageUpdatedAt === 0 ? { done: 0, total: 0 } : null)
    return buildReport(index.totals(), prices, range, { home: homedir(), scanning: progress, updatedAt: usageUpdatedAt })
  }

  async function showStatus(): Promise<void> {
    const { statusBarIgnore } = await readSettings()
    const quota = snapshot ? statusBarState(summarize(snapshot), statusBarIgnore.split(',')) : null
    // Desktop only; a headless host has no status bar.
    await orca.host
      .call('statusBar.update', { id: STATUS_ITEM, ...usageStatusBar(report('today'), quota) })
      .catch(() => undefined)
  }

  // ---- usage ------------------------------------------------------------------------------------

  async function scanUsage(): Promise<void> {
    if (Date.now() - pricesAt > PRICES_EVERY_MS) {
      prices = await loadPrices(join(dir, 'prices.json'), (await readSettings()).fetchPrices)
      pricesAt = Date.now()
    }
    let progressAt = Date.now()
    const changed = await index.scan(
      (done, total) => {
        scanning = done < total ? { done, total } : null
        // The first scan reads every log; show its totals as they grow.
        if (Date.now() - progressAt > PROGRESS_EVERY_MS) {
          progressAt = Date.now()
          orca.panels.post('usage.updated', { updatedAt: usageUpdatedAt })
          void showStatus()
        }
      },
      () => stopped
    )
    scanning = null
    usageUpdatedAt = Date.now()
    if (changed) {
      orca.panels.post('usage.updated', { updatedAt: usageUpdatedAt })
    }
    await showStatus()
  }

  /** One scan at a time; a caller during a scan shares it. */
  function refreshUsage(): Promise<void> {
    scanned ??= scanUsage()
      .catch((error) => orca.log(`usage scan failed: ${String(error)}`))
      .finally(() => {
        scanned = null
      })
    return scanned
  }

  function scheduleUsage(): void {
    if (stopped) {
      return
    }
    usageTimer = setTimeout(() => void refreshUsage().finally(scheduleUsage), USAGE_EVERY_MS)
  }

  // ---- quota ------------------------------------------------------------------------------------

  async function collect(): Promise<QuotaSnapshot> {
    // Storage, posts and answers take plain JSON only: drop the fields left undefined.
    const next = JSON.parse(
      JSON.stringify(await collectQuotas(await readSettings(), await readSecrets()))
    ) as QuotaSnapshot
    snapshot = next
    await orca.storage.set(SNAPSHOT_KEY, next)
    orca.panels.post('quota.updated', next)
    await showStatus()
    return next
  }

  /** One collection at a time; a caller during a run shares it. */
  function refreshQuota(): Promise<QuotaSnapshot> {
    running ??= collect().finally(() => {
      running = null
    })
    return running
  }

  async function scheduleQuota(): Promise<void> {
    if (quotaTimer) {
      clearTimeout(quotaTimer)
    }
    const { refreshMinutes } = await readSettings()
    // A refresh that ends after deactivate must not start the next one.
    if (stopped) {
      return
    }
    quotaTimer = setTimeout(
      () => {
        void refreshQuota()
          .catch((error) => orca.log(`quota refresh failed: ${String(error)}`))
          .finally(scheduleQuota)
      },
      Math.max(2, refreshMinutes) * 60_000
    )
  }

  orca.panels.handle('usage.get', async ({ range, refresh }) => {
    // During the first scan the panel already gets progress; waiting could outlast the request.
    if (refresh && !scanning) {
      await refreshUsage()
    }
    return report(range)
  })
  orca.panels.handle('quota.get', async ({ refresh: fresh }) => (fresh || !snapshot ? refreshQuota() : snapshot))

  orca.commands.register('usage.refresh', async () => {
    await Promise.all([refreshUsage(), refreshQuota().catch(() => null)])
    const { statusBarIgnore } = await readSettings()
    const quota = snapshot ? statusBarState(summarize(snapshot), statusBarIgnore.split(',')) : null
    return usageStatusBar(report('today'), quota).tooltip
  })

  orca.settings.onDidChange(() => {
    pricesAt = 0
    void refreshQuota().finally(scheduleQuota)
  })

  void (async () => {
    await index.load()
    const stored = (await orca.storage.get(SNAPSHOT_KEY)) as QuotaSnapshot | null
    if (stored && !snapshot) {
      snapshot = stored
    }
    await showStatus()
    await refreshUsage()
    scheduleUsage()
  })()

  void (async () => {
    await refreshQuota().catch((error) => orca.log(`quota refresh failed: ${String(error)}`))
    await scheduleQuota()
  })()
}

export function deactivate(): void {
  stopped = true
  for (const timer of [quotaTimer, usageTimer]) {
    if (timer) {
      clearTimeout(timer)
    }
  }
  quotaTimer = null
  usageTimer = null
}
