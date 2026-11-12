// The plugin's worker. Orca keeps it running while the plugin is enabled (it owns a status bar
// item), so it polls every source on a timer, keeps the last snapshot in orca.storage, updates
// the status bar, and pushes each snapshot to open panels.
import type { OrcaWorkerApi } from 'orca/worker'
import { collectQuotas, type QuotaSecrets, type QuotaSettings } from './collect'
import { SECRET_KEYS, type QuotaSnapshot } from './protocol'
import { statusBarState, summarize } from './summary'

const SNAPSHOT_KEY = 'snapshot:v1'
const STATUS_ITEM = 'quota'

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  let snapshot: QuotaSnapshot | null = null
  let running: Promise<QuotaSnapshot> | null = null

  async function readSettings(): Promise<
    QuotaSettings & { refreshMinutes: number; statusBarIgnore: string }
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

  async function showStatus(current: QuotaSnapshot): Promise<void> {
    const { statusBarIgnore } = await readSettings()
    const state = statusBarState(summarize(current), statusBarIgnore.split(','))
    // Desktop only; a headless host has no status bar.
    await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...state }).catch(() => undefined)
  }

  async function collect(): Promise<QuotaSnapshot> {
    // Storage, posts and answers take plain JSON only: drop the fields left undefined.
    const next = JSON.parse(
      JSON.stringify(await collectQuotas(await readSettings(), await readSecrets()))
    ) as QuotaSnapshot
    snapshot = next
    await orca.storage.set(SNAPSHOT_KEY, next)
    orca.panels.post('quota.updated', next)
    await showStatus(next)
    return next
  }

  /** One collection at a time; a caller during a run shares it. */
  function refresh(): Promise<QuotaSnapshot> {
    running ??= collect().finally(() => {
      running = null
    })
    return running
  }

  async function schedule(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
    }
    const { refreshMinutes } = await readSettings()
    // A refresh that ends after deactivate must not start the next one.
    if (stopped) {
      return
    }
    timer = setTimeout(
      () => {
        void refresh()
          .catch((error) => orca.log(`refresh failed: ${String(error)}`))
          .finally(schedule)
      },
      Math.max(2, refreshMinutes) * 60_000
    )
  }

  orca.panels.handle('quota.get', async ({ refresh: fresh }) => (fresh || !snapshot ? refresh() : snapshot))

  orca.commands.register('quota.refresh', async () => {
    const current = await refresh()
    return statusBarState(summarize(current), []).tooltip
  })

  orca.settings.onDidChange(() => {
    void refresh().finally(schedule)
  })

  void (async () => {
    const stored = (await orca.storage.get(SNAPSHOT_KEY)) as QuotaSnapshot | null
    if (stored && !snapshot) {
      snapshot = stored
      await showStatus(stored)
    }
    await refresh().catch((error) => orca.log(`refresh failed: ${String(error)}`))
    await schedule()
  })()
}

export function deactivate(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
