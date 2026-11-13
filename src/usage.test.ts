// Log parsers, the incremental index, prices and the report, on made-up records.
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { assert, test } from 'orca/testing'
import { priceFor, reducePrices } from './usage/pricing'
import { buildReport, projectLabel, usageStatusBar } from './usage/report'
import { dayKey, UsageIndex, type Totals } from './usage/scanner'
import {
  antigravityEvents,
  antigravityModel,
  claudeEvents,
  codexEvents,
  codexSession,
  dshEvents,
  grokEvents,
  opencodeEvent,
  piEvents,
  type FileState,
  type LineSource
} from './usage/sources'

const AT = '2026-11-13T10:00:00.000Z'

const claudeLine = (id: string, input = 10) => ({
  type: 'assistant',
  timestamp: AT,
  cwd: '/work/app',
  requestId: `req-${id}`,
  message: {
    id,
    model: 'claude-opus-5-5',
    usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
  }
})

test('Claude Code: one event per response, though each content block repeats it', () => {
  const state: FileState = {}
  assert.equal(claudeEvents(claudeLine('m1'), state).length, 1)
  assert.equal(claudeEvents(claudeLine('m1'), state).length, 0)
  const [event] = claudeEvents(claudeLine('m2', 7), state)
  assert.deepEqual(
    [event.model, event.cwd, event.input, event.output, event.cacheRead, event.cacheWrite, event.cost],
    ['claude-opus-5-5', '/work/app', 7, 5, 100, 20, null]
  )
  const synthetic = { ...claudeLine('m3'), message: { ...claudeLine('m3').message, model: '<synthetic>' } }
  assert.equal(claudeEvents(synthetic, state).length, 0)
})

test('Codex: counts a token_count only when the thread total moves', () => {
  const state: FileState = {}
  codexEvents({ type: 'turn_context', payload: { cwd: '/work/api', model: 'gpt-5.6-terra' } }, state)
  const count = (total: number) => ({
    type: 'event_msg',
    timestamp: AT,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 }
      }
    }
  })
  const [event] = codexEvents(count(1050), state)
  assert.deepEqual([event.model, event.input, event.cacheRead, event.output, event.reasoning], ['gpt-5.6-terra', 200, 800, 50, 20])
  assert.equal(codexEvents(count(1050), state).length, 0)
  assert.equal(codexEvents(count(2100), state).length, 1)
  assert.equal(state.cwd, '/work/api')
})

test('pi and omp: their own cost, unless they logged 0', () => {
  const state: FileState = {}
  piEvents({ type: 'session', cwd: '/work/pi' }, state)
  const line = (total: number) => ({
    type: 'message',
    timestamp: AT,
    message: {
      role: 'assistant',
      model: 'gpt-5.6-luna',
      usage: { input: 30, output: 3, cacheRead: 300, cacheWrite: 0, reasoning: 1, cost: { total } }
    }
  })
  assert.equal(piEvents(line(0.25), state)[0].cost, 0.25)
  assert.equal(piEvents(line(0), state)[0].cost, null)
  assert.equal(state.cwd, '/work/pi')
  assert.equal(piEvents({ type: 'message', message: { role: 'user' } }, state).length, 0)
})

test('Grok: a prompt per line, its cost in ticks, its folder named after the cwd', () => {
  const [event] = grokEvents(
    {
      timestamp: 1794333820,
      params: {
        update: {
          usage: {
            modelUsage: {
              'grok-4.7-build': {
                inputTokens: 1000,
                cachedReadTokens: 600,
                outputTokens: 40,
                reasoningTokens: 10,
                cacheCreationTokens: 0,
                costUsdTicks: 5_000_000_000
              }
            }
          }
        }
      }
    },
    {},
    '/home/me/.grok/sessions/%2Fwork%2Fgrok/0193/updates.jsonl'
  )
  assert.deepEqual(
    [event.model, event.cwd, event.input, event.cacheRead, event.output, event.cost],
    ['grok-4.7-build', '/work/grok', 400, 600, 40, 0.5]
  )
})

test('dsh and OpenCode', () => {
  const state: FileState = {}
  dshEvents({ type: 'session', cwd: '/work/dsh' }, state)
  const [dsh] = dshEvents(
    {
      type: 'assistant/message',
      time: 1794504850647,
      data: {
        message: { source: { model: 'deepseek-flash' } },
        usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 0 }
      }
    },
    state
  )
  assert.deepEqual([dsh.model, dsh.input, dsh.cacheRead, state.cwd], ['deepseek-flash', 9, 90, '/work/dsh'])
  const open = opencodeEvent({ at: 1789788395277, model: 'big-pickle', cwd: '/work/oc', input: 96, output: 19, reasoning: 4, cacheRead: 8192, cacheWrite: 0, cost: 0 })
  assert.deepEqual([open.output, open.reasoning, open.cost], [23, 4, null])
})

test('Antigravity: tokens per planner response, the model from the conversation database', () => {
  const [event] = antigravityEvents(
    { type: 'PLANNER_RESPONSE', created_at: AT, input_tokens: 3004, cache_read_tokens: 24138, output_tokens: 119 },
    { model: 'gemini-3.8-flash' }
  )
  assert.deepEqual([event.model, event.input, event.cacheRead, event.output], ['gemini-3.8-flash', 3004, 24138, 119])
  assert.equal(antigravityEvents({ type: 'USER_INPUT', input_tokens: 5 }, {}).length, 0)
  const label = '\x12model_enum\x1aMODEL_PLACEHOLDER_M318R\x17Gemini 3.8 Flash (High)\x00'
  assert.equal(antigravityModel(label + label + 'MODEL_X\x05\x10Claude Opus 5 (Thinking)'), 'gemini-3.8-flash')
  assert.equal(antigravityModel('/tmp/claude-501/x gemini-3.8-flash-high\x00 gemini-3.8-flash-n'), 'gemini-3.8-flash')
  assert.equal(antigravityModel('nothing here'), undefined)
})

test('the index reads only lines added since the last scan, and starts over on a rewrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-usage-'))
  const log = join(dir, 'session.jsonl')
  const source: LineSource = { agent: 'Claude Code', hints: ['"usage"'], parse: claudeEvents, list: async () => [log] }
  await writeFile(log, `${JSON.stringify(claudeLine('a'))}\n${JSON.stringify({ type: 'user' })}\n`)
  const index = new UsageIndex(join(dir, 'index.json'), [source], [])
  assert.equal(await index.scan(), true)
  assert.equal(await index.scan(), false)
  // A line still being written is left for the next scan.
  await appendFile(log, `${JSON.stringify(claudeLine('b'))}\n${JSON.stringify(claudeLine('c')).slice(0, 40)}`)
  await index.scan()
  const responses = (): number => [...index.totals().values()].reduce((sum, totals) => sum + totals[5], 0)
  assert.equal(responses(), 2)

  const reloaded = new UsageIndex(join(dir, 'index.json'), [source], [])
  await reloaded.load()
  assert.equal([...reloaded.totals().values()][0][5], 2)

  await writeFile(log, `${JSON.stringify(claudeLine('z'))}\n`)
  await index.scan()
  assert.equal(responses(), 1)
})

test('a zstd log written as many frames is read whole, without a frame cut short', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-usage-'))
  const log = join(dir, 'session.v4.jsonl.zstd')
  const reply = (seq: number) => ({
    type: 'assistant/message',
    time: Date.parse(AT) + seq,
    data: { message: { source: { model: 'deepseek-flash' } }, usage: { inputTokens: 5, outputTokens: 1 } }
  })
  const frames = [{ type: 'session', cwd: '/work/dsh' }, reply(1), reply(2)].map((line) =>
    zstdCompressSync(`${JSON.stringify(line)}\n`)
  )
  const cut = zstdCompressSync(`${JSON.stringify(reply(3))}\n`).subarray(0, 12)
  await writeFile(log, Buffer.concat([...frames, cut]))
  const source: LineSource = { agent: 'dsh', hints: ['"usage"', '"cwd"'], parse: dshEvents, list: async () => [log] }
  const index = new UsageIndex(join(dir, 'index.json'), [source], [])
  await index.scan()
  const [[key, totals]] = [...index.totals()]
  assert.equal(totals[5], 2)
  assert.match(key, /\t\/work\/dsh\t/)
})

test('a Codex session copied to another home, or compressed, counts once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-usage-'))
  await mkdir(join(dir, 'a'))
  await mkdir(join(dir, 'b'))
  const lines = [
    { type: 'turn_context', payload: { cwd: '/work/api', model: 'gpt-5.5' } },
    {
      type: 'event_msg',
      timestamp: AT,
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 10 }, last_token_usage: { input_tokens: 8, output_tokens: 2 } }
      }
    }
  ]
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  const plain = join(dir, 'a', 'rollout-1.jsonl')
  const compressed = join(dir, 'b', 'rollout-1.jsonl.zst')
  await writeFile(plain, text)
  await writeFile(compressed, zstdCompressSync(text))
  assert.equal(codexSession(compressed), 'rollout-1.jsonl')
  const source: LineSource = {
    agent: 'Codex',
    hints: ['token_count', 'turn_context'],
    parse: codexEvents,
    identity: codexSession,
    list: async () => [plain, compressed]
  }
  const index = new UsageIndex(join(dir, 'index.json'), [source], [])
  await index.scan()
  assert.equal([...index.totals().values()].reduce((sum, totals) => sum + totals[5], 0), 1)
})

test('prices: LiteLLM entries, model names as agents log them, free models', () => {
  const table = reducePrices({
    'claude-opus-4-6': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 5e-7 },
    'xai/grok-4.6': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
    sample_spec: { max_tokens: 1 }
  })
  assert.deepEqual(table['claude-opus-4-6'], [5e-6, 25e-6, 5e-7, 5e-6])
  assert.equal(table.sample_spec, undefined)
  assert.ok(priceFor(table, 'claude-opus-4.6'))
  assert.ok(priceFor(table, 'thatnghiepdev/grok-4.6'))
  assert.deepEqual(priceFor(table, 'oc/deepseek-v4-flash-free'), [0, 0, 0, 0])
  assert.equal(priceFor(table, 'qfmodel'), null)
})

test('the report sums a range by agent, model, project and day', () => {
  const now = new Date(2026, 10, 13, 12)
  const today = dayKey(now.getTime())
  const yesterday = dayKey(new Date(2026, 10, 12, 12).getTime())
  const old = dayKey(new Date(2026, 8, 1, 12).getTime())
  const bucket = (input: number, cost = 0): Totals => [input, 100, 1000, 0, 0, 1, cost]
  const buckets = new Map<string, Totals>([
    [`Claude Code\t${today}\tclaude-opus-4-6\t/work/orca/app\tP`, bucket(1000)],
    [`pi\t${today}\tqfmodel\t/work/orca/app\tP`, bucket(10)],
    [`pi\t${yesterday}\tgpt-x\t/home/me\tL`, bucket(0, 1.5)],
    [`Codex\t${old}\tgpt-x\t\tL`, bucket(0, 9)]
  ])
  const prices = { 'claude-opus-4-6': [1e-6, 1e-5, 1e-7, 1e-6] as [number, number, number, number] }
  const options = { home: '/home/me', scanning: null, updatedAt: 1, now }

  const day = buildReport(buckets, prices, 'today', options)
  assert.equal(day.totals.calls, 2)
  assert.equal(day.totals.tokens, 1100 + 110 + 2000)
  assert.equal(day.totals.unpriced, 1110)
  assert.equal(Number(day.totals.cost.toFixed(6)), 0.0021)
  assert.deepEqual(day.agents.map((row) => row.label), ['Claude Code', 'pi'])
  assert.deepEqual(day.projects.map((row) => row.label), ['orca/app'])
  assert.deepEqual(day.series, [])

  const week = buildReport(buckets, prices, '7d', options)
  assert.equal(week.series.length, 7)
  assert.equal(week.series.at(-2)?.cost, 1.5)
  assert.equal(week.totals.calls, 3)

  const all = buildReport(buckets, prices, 'all', options)
  assert.deepEqual(all.series.map((point) => point.label), ['2026-09', '2026-10', '2026-11'])
  assert.equal(all.totals.calls, 4)

  assert.equal(projectLabel('/home/me', '/home/me'), '~')
  assert.equal(projectLabel('', '/home/me'), 'Unknown')

  const bar = usageStatusBar(day, { text: 'Claude 5%', tone: 'danger' })
  assert.equal(bar.text, '3.2K · <$0.01 · Claude 5%')
  assert.equal(bar.tone, 'danger')
  assert.equal(
    bar.tooltip,
    'Today: 3.2K tokens, ≈ <$0.01 · Claude Code 2.1K, pi 1.1K · 1.1K unpriced · lowest quota: Claude 5% left'
  )
  assert.equal(usageStatusBar(day, { text: 'Codex 80%', tone: 'neutral' }).text, '3.2K · <$0.01')
  // Orca refuses a longer tooltip outright.
  const crowded = { ...day, agents: Array.from({ length: 40 }, (_, i) => ({ ...day.agents[0], label: `agent-${i}` })) }
  assert.ok(usageStatusBar(crowded, null).tooltip.length <= 256)
})
