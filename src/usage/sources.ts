// Where each agent logs the tokens it used, and how to read one record. Read only: nothing here
// writes to an agent's files or sends them anywhere.
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toEpochMs } from '../http'

/** One model response. `input` excludes cached input; `output` includes reasoning. */
export type UsageEvent = {
  at: number
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** USD the agent logged itself; null prices it from the model table. */
  cost: number | null
  /** Overrides the file's working directory. */
  cwd?: string
}

/** What a log's earlier lines said, kept between reads of a growing file. */
export type FileState = {
  cwd?: string
  model?: string
  /** Last few message ids, for logs that repeat a response once per content block. */
  recent?: string[]
  /** Codex: the thread's running total at the last counted event. */
  total?: number
}

type Json = Record<string, unknown>

/** A JSONL log source. Files ending in .zst or .zstd are read whole each time they change. */
export type LineSource = {
  agent: string
  list(): Promise<string[]>
  /** Fills in what the log itself does not say (model, cwd), before each read of a changed file. */
  prepare?: (path: string, state: FileState) => Promise<void>
  /** Names the session a file holds, when copies of it can sit at other paths; one copy counts. */
  identity?: (path: string) => string
  /** A line without any of these is skipped before parsing; most lines are not usage. */
  hints: string[]
  parse(entry: Json, state: FileState, path: string): UsageEvent[]
}

/** A source read whole each time its signature changes (a database). */
export type WholeSource = {
  agent: string
  path(): string
  signature(): Promise<string | null>
  read(): Promise<UsageEvent[]>
}

const obj = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const home = (): string => homedir()

async function walk(root: string, keep: (path: string) => boolean): Promise<string[]> {
  try {
    const names = await readdir(root, { recursive: true })
    return names.map((name) => join(root, name)).filter(keep)
  } catch {
    return []
  }
}

/** True when `key` was among the last few ids of this file. */
function seenRecently(state: FileState, key: string): boolean {
  const recent = state.recent ?? []
  if (recent.includes(key)) {
    return true
  }
  state.recent = [...recent.slice(-31), key]
  return false
}

// ---- Claude Code -------------------------------------------------------------------------------

export function claudeEvents(entry: Json, state: FileState): UsageEvent[] {
  const message = obj(entry.message)
  const usage = obj(message?.usage)
  const model = str(message?.model)
  if (entry.type !== 'assistant' || !message || !usage || !model || model === '<synthetic>') {
    return []
  }
  // Claude Code writes a response once per content block, each line with the same usage.
  if (seenRecently(state, `${String(message.id)}:${String(entry.requestId)}`)) {
    return []
  }
  return [
    {
      at: toEpochMs(entry.timestamp) ?? 0,
      model,
      cwd: str(entry.cwd),
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
      reasoning: 0,
      cost: null
    }
  ]
}

// ---- Codex -------------------------------------------------------------------------------------

export function codexEvents(entry: Json, state: FileState): UsageEvent[] {
  const payload = obj(entry.payload)
  if (entry.type === 'session_meta' || entry.type === 'turn_context') {
    state.cwd = str(payload?.cwd) ?? state.cwd
    state.model = str(payload?.model) ?? state.model
    return []
  }
  if (entry.type !== 'event_msg' || payload?.type !== 'token_count') {
    return []
  }
  const info = obj(payload.info)
  const last = obj(info?.last_token_usage)
  const total = n(obj(info?.total_token_usage)?.total_tokens)
  // Codex repeats a token_count without a new response; only a changed total is new usage.
  if (!last || total === state.total) {
    return []
  }
  state.total = total
  const cached = n(last.cached_input_tokens)
  return [
    {
      at: toEpochMs(entry.timestamp) ?? 0,
      model: state.model ?? 'codex',
      input: Math.max(0, n(last.input_tokens) - cached),
      output: n(last.output_tokens),
      cacheRead: cached,
      cacheWrite: n(last.cache_write_input_tokens),
      reasoning: n(last.reasoning_output_tokens),
      cost: null
    }
  ]
}

// ---- pi and omp --------------------------------------------------------------------------------

export function piEvents(entry: Json, state: FileState): UsageEvent[] {
  if (entry.type === 'session') {
    state.cwd = str(entry.cwd) ?? state.cwd
    return []
  }
  const message = obj(entry.message)
  const usage = obj(message?.usage)
  if (entry.type !== 'message' || message?.role !== 'assistant' || !usage) {
    return []
  }
  const cost = n(obj(usage.cost)?.total)
  return [
    {
      at: toEpochMs(entry.timestamp) ?? toEpochMs(message.timestamp) ?? 0,
      model: str(message.model) ?? 'unknown',
      input: n(usage.input),
      output: n(usage.output),
      cacheRead: n(usage.cacheRead),
      cacheWrite: n(usage.cacheWrite),
      reasoning: n(usage.reasoning),
      // A provider pi has no prices for logs 0; price those from the table instead.
      cost: cost > 0 ? cost : null
    }
  ]
}

// ---- Grok CLI ----------------------------------------------------------------------------------

/** xAI bills in ticks of 1e-10 USD. */
const USD_PER_TICK = 1e-10

export function grokEvents(entry: Json, _state: FileState, path: string): UsageEvent[] {
  const usage = obj(obj(obj(entry.params)?.update)?.usage)
  const models = obj(usage?.modelUsage)
  if (!models) {
    return []
  }
  // sessions/<url-encoded cwd>/<session id>/updates.jsonl; one usage line per prompt.
  let cwd: string | undefined
  try {
    cwd = decodeURIComponent(basename(dirname(dirname(path))))
  } catch {
    cwd = undefined
  }
  return Object.entries(models).flatMap(([model, value]) => {
    const used = obj(value)
    if (!used) {
      return []
    }
    const cached = n(used.cachedReadTokens)
    const ticks = n(used.costUsdTicks)
    return [
      {
        at: toEpochMs(entry.timestamp) ?? 0,
        model,
        cwd,
        input: Math.max(0, n(used.inputTokens) - cached),
        output: n(used.outputTokens),
        cacheRead: cached,
        cacheWrite: n(used.cacheCreationTokens),
        reasoning: n(used.reasoningTokens),
        cost: ticks > 0 ? ticks * USD_PER_TICK : null
      }
    ]
  })
}

// ---- DeepSeek Harness (dsh) --------------------------------------------------------------------

export function dshEvents(entry: Json, state: FileState): UsageEvent[] {
  if (entry.type === 'session') {
    state.cwd = str(entry.cwd) ?? state.cwd
    return []
  }
  const data = obj(entry.data)
  const usage = obj(data?.usage)
  if (entry.type !== 'assistant/message' || !usage) {
    return []
  }
  const source = obj(obj(data?.message)?.source)
  return [
    {
      at: toEpochMs(entry.time) ?? 0,
      model: str(source?.model) ?? 'deepseek',
      input: n(usage.inputTokens),
      output: n(usage.outputTokens),
      cacheRead: n(usage.cacheReadTokens),
      cacheWrite: n(usage.cacheWriteTokens),
      reasoning: 0,
      cost: null
    }
  ]
}

// ---- Antigravity CLI (agy) ---------------------------------------------------------------------

export function antigravityEvents(entry: Json, state: FileState): UsageEvent[] {
  if (entry.type !== 'PLANNER_RESPONSE' || typeof entry.input_tokens !== 'number') {
    return []
  }
  return [
    {
      at: toEpochMs(entry.created_at) ?? 0,
      model: state.model ?? 'gemini',
      input: n(entry.input_tokens),
      output: n(entry.output_tokens),
      cacheRead: n(entry.cache_read_tokens),
      cacheWrite: 0,
      reasoning: 0,
      cost: null
    }
  ]
}

const AGY_LABEL = /MODEL_[A-Z0-9_]+[\s\S]{1,4}?((?:Gemini|Claude|GPT) [A-Za-z0-9 .()-]{1,60})/g
const AGY_ID = /\b(gemini-\d[\w.-]*|claude-[a-z]+-\d[\w.-]*|gpt-\d[\w.-]*)/g

/** The model a conversation used most, from its database's raw bytes: the transcript does not name
 *  it, and its records are protobuf. `Gemini 3.8 Flash (High)` and `gemini-3.8-flash-high` both
 *  become `gemini-3.8-flash`, the name the price table knows. */
export function antigravityModel(bytes: string): string | undefined {
  const counts = new Map<string, number>()
  const add = (raw: string): void => {
    const model = raw
      .replace(/\s*\(.*$/, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/-(high|medium|low|n|tiered)$/, '')
    counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  for (const match of bytes.matchAll(AGY_LABEL)) {
    add(match[1])
  }
  if (counts.size === 0) {
    for (const match of bytes.matchAll(AGY_ID)) {
      add(match[1])
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** brain/<conversation>/.system_generated/logs/transcript_full.jsonl → model and workspace. */
async function prepareAntigravity(path: string, state: FileState): Promise<void> {
  const root = dirname(dirname(dirname(dirname(dirname(path)))))
  const conversation = basename(dirname(dirname(dirname(path))))
  const database = join(root, 'conversations', `${conversation}.db`)
  const parts = await Promise.all(
    [database, `${database}-wal`].map((file) => readFile(file, 'latin1').catch(() => ''))
  )
  state.model = antigravityModel(parts.join('')) ?? state.model
  try {
    const metadata = JSON.parse(await readFile(join(root, 'cache', 'conversation_metadata.json'), 'utf8')) as Json
    const summary = obj(obj(obj(metadata.conversations)?.[conversation])?.summary)
    const workspace = Array.isArray(summary?.WorkspaceURIs) ? str(summary.WorkspaceURIs[0]) : undefined
    state.cwd = workspace?.startsWith('file:') ? fileURLToPath(workspace) : state.cwd
  } catch {
    // No metadata: the conversation counts under an unknown project.
  }
}

// ---- OpenCode ----------------------------------------------------------------------------------

const OPENCODE_QUERY = `select time_created as at,
  json_extract(data, '$.modelID') as model,
  json_extract(data, '$.path.cwd') as cwd,
  json_extract(data, '$.tokens.input') as input,
  json_extract(data, '$.tokens.output') as output,
  json_extract(data, '$.tokens.reasoning') as reasoning,
  json_extract(data, '$.tokens.cache.read') as cacheRead,
  json_extract(data, '$.tokens.cache.write') as cacheWrite,
  json_extract(data, '$.cost') as cost
from message
where json_extract(data, '$.role') = 'assistant' and json_extract(data, '$.tokens') is not null`

export function opencodeEvent(row: Json): UsageEvent {
  const cost = n(row.cost)
  return {
    at: n(row.at),
    model: str(row.model) ?? 'unknown',
    cwd: str(row.cwd),
    input: n(row.input),
    // OpenCode counts reasoning apart from output.
    output: n(row.output) + n(row.reasoning),
    cacheRead: n(row.cacheRead),
    cacheWrite: n(row.cacheWrite),
    reasoning: n(row.reasoning),
    cost: cost > 0 ? cost : null
  }
}

/** Read-only query: node:sqlite when the runtime has it, else the sqlite3 command. */
async function queryReadOnly(path: string, sql: string): Promise<Json[]> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare(sql).all() as Json[]
    } finally {
      db.close()
    }
  } catch {
    // Fails rather than answering empty, so an unreadable database keeps its earlier totals.
    return new Promise((resolve, reject) => {
      execFile(
        'sqlite3',
        ['-readonly', '-json', path, sql],
        { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error)
            return
          }
          try {
            resolve(stdout.trim() ? (JSON.parse(stdout) as Json[]) : [])
          } catch (parseError) {
            reject(parseError)
          }
        }
      )
    })
  }
}

async function fileSignature(paths: string[]): Promise<string | null> {
  const parts: string[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      parts.push(`${info.size}:${Math.trunc(info.mtimeMs)}`)
    } catch {
      parts.push('-')
    }
  }
  return parts[0] === '-' ? null : parts.join('|')
}

// ---- the list ----------------------------------------------------------------------------------

const isLog = (path: string): boolean => /\.jsonl(\.zst)?$/.test(path)

async function subfolders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/** Codex homes: its own, and the one Orca keeps per Codex account it manages (macOS, Linux,
 *  Windows), where Orca's Codex terminals log their sessions. */
async function codexHomes(): Promise<string[]> {
  const homes = [process.env.CODEX_HOME, join(home(), '.codex')]
  const orcaDirs = [
    join(home(), 'Library', 'Application Support', 'orca'),
    join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'orca'),
    process.env.APPDATA ? join(process.env.APPDATA, 'orca') : undefined
  ]
  for (const orca of orcaDirs.filter((dir): dir is string => Boolean(dir))) {
    const accounts = await subfolders(join(orca, 'codex-accounts'))
    homes.push(...accounts.map((account) => join(account, 'home')), join(orca, 'codex-runtime-home', 'home'))
  }
  return [...new Set(homes.filter((dir): dir is string => Boolean(dir)))]
}

/** A Codex session's file name: the same in every home it was copied to, with or without `.zst`. */
export const codexSession = (path: string): string => basename(path).replace(/\.zst$/, '')

/** One file per session: a plain log over a compressed copy, else the largest. */
async function onePerSession(paths: string[]): Promise<string[]> {
  const best = new Map<string, { path: string; plain: boolean; size: number }>()
  for (const path of paths) {
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      continue
    }
    const plain = !path.endsWith('.zst')
    const current = best.get(codexSession(path))
    if (!current || (plain && !current.plain) || (plain === current.plain && size > current.size)) {
      best.set(codexSession(path), { path, plain, size })
    }
  }
  return [...best.values()].map((choice) => choice.path)
}

export function lineSources(): LineSource[] {
  const claudeDirs = [
    process.env.CLAUDE_CONFIG_DIR || join(home(), '.claude'),
    join(home(), '.config', 'claude')
  ]
  return [
    {
      agent: 'Claude Code',
      hints: ['"usage"'],
      parse: claudeEvents,
      list: async () =>
        (await Promise.all([...new Set(claudeDirs)].map((dir) => walk(join(dir, 'projects'), isLog)))).flat()
    },
    {
      agent: 'Codex',
      hints: ['token_count', 'session_meta', 'turn_context'],
      parse: codexEvents,
      identity: codexSession,
      list: async () => {
        const paths: string[] = []
        for (const dir of await codexHomes()) {
          paths.push(...(await walk(join(dir, 'sessions'), isLog)), ...(await walk(join(dir, 'archived_sessions'), isLog)))
        }
        return onePerSession(paths)
      }
    },
    {
      agent: 'pi',
      hints: ['"usage"', '"cwd"'],
      parse: piEvents,
      list: () => walk(join(process.env.PI_CODING_AGENT_DIR || join(home(), '.pi', 'agent'), 'sessions'), isLog)
    },
    {
      agent: 'omp',
      hints: ['"usage"', '"cwd"'],
      parse: piEvents,
      list: () => walk(join(home(), '.omp', 'agent', 'sessions'), isLog)
    },
    {
      agent: 'Grok',
      hints: ['"modelUsage"'],
      parse: grokEvents,
      list: () =>
        walk(join(process.env.GROK_HOME || join(home(), '.grok'), 'sessions'), (path) =>
          path.endsWith('updates.jsonl')
        )
    },
    {
      agent: 'Antigravity',
      hints: ['PLANNER_RESPONSE'],
      parse: antigravityEvents,
      prepare: prepareAntigravity,
      list: () =>
        walk(join(home(), '.gemini', 'antigravity-cli', 'brain'), (path) =>
          path.endsWith(join('.system_generated', 'logs', 'transcript_full.jsonl'))
        )
    },
    {
      agent: 'dsh',
      hints: ['"usage"', '"cwd"'],
      parse: dshEvents,
      list: () =>
        walk(join(home(), '.dsh', 'sessions'), (path) => /session\.v\d+\.jsonl(\.zstd?)?$/.test(path))
    }
  ]
}

export function wholeSources(): WholeSource[] {
  const db = join(process.env.XDG_DATA_HOME || join(home(), '.local', 'share'), 'opencode', 'opencode.db')
  return [
    {
      agent: 'OpenCode',
      path: () => db,
      signature: () => fileSignature([db, `${db}-wal`]),
      read: async () => (await queryReadOnly(db, OPENCODE_QUERY)).map(opencodeEvent)
    }
  ]
}
