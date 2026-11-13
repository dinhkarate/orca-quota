// Runs src/worker.ts's activate(orca) over a mock host, in a made-up home folder with one
// Claude Code log, every quota source off and price downloads off, so nothing leaves the machine.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const OFF = {
  claude: false,
  codex: false,
  grok: false,
  copilot: false,
  openrouter: false,
  deepseek: false,
  readAgentConfigs: false,
  fetchPrices: false,
  nineRouterUrl: ''
}

const ENV_KEYS = ['HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'GROK_HOME']

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-usage-home-'))
  const project = join(home, '.claude', 'projects', '-work-app')
  await mkdir(project, { recursive: true })
  const line = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    cwd: join(home, 'work', 'app'),
    requestId: 'r1',
    message: {
      id: 'm1',
      model: 'claude-opus-4-6',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  }
  await writeFile(join(project, 's.jsonl'), `${JSON.stringify(line)}\n`)
  // A fresh price cache, so the worker prices without downloading.
  const data = join(home, '.local', 'share', 'orca-agent-usage')
  await mkdir(data, { recursive: true })
  await writeFile(
    join(data, 'prices.json'),
    JSON.stringify({ fetchedAt: Date.now(), table: { 'claude-opus-4-6': [1e-6, 1e-5, 0, 0] } })
  )
  return home
}

test('reads usage from the logs, answers reports and puts today in the status bar', async () => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  process.env.HOME = await fakeHome()
  const host = mockHost({ capabilities: ['storage:own', 'settings:own', 'secrets:own'], settings: OFF })
  const worker = await mountWorker(main, { host, commands: ['usage.refresh'] })
  try {
    const report = await worker.request('usage.get', { range: 'today', refresh: true })
    assert.equal(report.totals.calls, 1)
    assert.equal(report.totals.tokens, 1100)
    assert.equal(report.totals.cost.toFixed(4), '0.0020')
    assert.deepEqual(report.projects.map((row) => row.label), ['work/app'])

    const snapshot = await worker.request('quota.get', { refresh: true })
    assert.deepEqual(snapshot?.accounts, [])
    assert.ok(host.data().storage['snapshot:v1'])

    const updates = host.callsOf('statusBar.update') as { id: string; text: string; tone: string }[]
    assert.deepEqual(
      [updates.at(-1)?.id, updates.at(-1)?.text, updates.at(-1)?.tone],
      ['usage', '1.1K · <$0.01', 'neutral']
    )
    assert.match(String(await worker.command('usage.refresh')), /Claude Code 1\.1K/)
    assert.deepEqual(worker.refusals, [], JSON.stringify(host.calls))
  } finally {
    await worker.deactivate()
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
  }
})
