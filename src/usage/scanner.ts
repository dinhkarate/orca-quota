// Reads every agent's logs into per-day totals and keeps them in a file of its own, so a restart
// reads only what the agents wrote since, and the history stays after an agent deletes old logs.
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { FileState, LineSource, UsageEvent, WholeSource } from './sources'

/** input, output, cache read, cache write, reasoning, responses, logged USD */
export type Totals = [number, number, number, number, number, number, number]

type FileEntry = {
  agent: string
  size: number
  mtime: number
  /** Bytes read so far. A compressed file is read whole each time it changes. */
  offset: number
  /** A whole source's signature (database size and time). */
  signature?: string
  /** The session the file holds, when copies of it can sit at other paths. */
  id?: string
  state: FileState
  /** `day \t model \t cwd \t L|P` → totals. L: the agent logged the cost; P: price it from the table. */
  buckets: Record<string, Totals>
}

type IndexData = { version: 2; files: Record<string, FileEntry> }

const SAVE_EVERY_FILES = 200

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local calendar day, YYYY-MM-DD. */
export function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function addEvent(buckets: Record<string, Totals>, event: UsageEvent, cwd: string | undefined): void {
  if (event.at <= 0) {
    return
  }
  const key = [dayKey(event.at), event.model, event.cwd ?? cwd ?? '', event.cost === null ? 'P' : 'L'].join('\t')
  const totals = (buckets[key] ??= [0, 0, 0, 0, 0, 0, 0])
  totals[0] += event.input
  totals[1] += event.output
  totals[2] += event.cacheRead
  totals[3] += event.cacheWrite
  totals[4] += event.reasoning
  totals[5] += 1
  totals[6] += event.cost ?? 0
}

const ZSTD_MAGIC = 0xfd2fb528
const ZSTD_SKIPPABLE = 0x184d2a50

/** Each frame of a zstd file. dsh appends one frame per write, and Node's decoder stops after the
 *  first, so the file is split here by walking frame headers and block sizes. A frame cut short
 *  (still being written) is left out. */
export function zstdFrames(data: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let at = 0
  while (at + 8 <= data.length) {
    const magic = data.readUInt32LE(at)
    if ((magic & 0xfffffff0) >>> 0 === ZSTD_SKIPPABLE) {
      at += 8 + data.readUInt32LE(at + 4)
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      break
    }
    const descriptor = data[at + 4]
    const singleSegment = (descriptor >> 5) & 1
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]
    const contentSizeBytes = [singleSegment, 2, 4, 8][descriptor >> 6]
    let position = at + 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    let last = 0
    while (!last && position + 3 <= data.length) {
      const header = data[position] | (data[position + 1] << 8) | (data[position + 2] << 16)
      last = header & 1
      // An RLE block stores one byte; raw and compressed blocks store their size.
      position += 3 + (((header >> 1) & 3) === 1 ? 1 : header >>> 3)
    }
    const end = position + ((descriptor >> 2) & 1 ? 4 : 0)
    if (!last || end > data.length) {
      break
    }
    frames.push(data.subarray(at, end))
    at = end
  }
  return frames
}

async function* zstdChunks(path: string): AsyncGenerator<Buffer> {
  for (const frame of zstdFrames(await readFile(path))) {
    yield* Readable.from([frame]).pipe(createZstdDecompress())
  }
}

/** Calls `onLine` for each complete line from `start`; returns the offset after the last one. */
async function readLines(
  path: string,
  start: number,
  compressed: boolean,
  onLine: (line: Buffer) => void
): Promise<number> {
  const stream = compressed ? zstdChunks(path) : createReadStream(path, { start })
  let consumed = start
  // A line can span many chunks (a long tool result); join its pieces once, at its newline.
  let pending: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0
    let newline = chunk.indexOf(10, from)
    while (newline !== -1) {
      const piece = chunk.subarray(from, newline)
      const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece
      pending = []
      consumed += line.length + 1
      onLine(line)
      from = newline + 1
      newline = chunk.indexOf(10, from)
    }
    if (from < chunk.length) {
      pending.push(chunk.subarray(from))
    }
  }
  // A whole file's last line may have no newline; a growing file's is read next time.
  if (compressed && pending.length > 0) {
    onLine(Buffer.concat(pending))
  }
  return consumed
}

export class UsageIndex {
  private data: IndexData = { version: 2, files: {} }
  private merged: Map<string, Totals> | null = null

  constructor(
    private readonly path: string,
    private readonly lines: LineSource[],
    private readonly whole: WholeSource[]
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as IndexData
      // An older version is read again from the logs.
      if (parsed?.version === 2 && parsed.files) {
        this.data = parsed
        this.merged = null
      }
    } catch {
      // No index yet: the first scan builds it.
    }
  }

  /** Reads what changed since the last scan; true when any totals changed. */
  async scan(progress?: (done: number, total: number) => void, stop?: () => boolean): Promise<boolean> {
    const jobs: (() => Promise<boolean>)[] = []
    for (const source of this.lines) {
      for (const path of await source.list()) {
        jobs.push(() => this.readLog(source, path))
      }
    }
    for (const source of this.whole) {
      jobs.push(() => this.readWhole(source))
    }
    let changed = false
    let unsaved = 0
    for (const [index, job] of jobs.entries()) {
      if (stop?.()) {
        break
      }
      if (await job().catch(() => false)) {
        changed = true
        this.merged = null
        unsaved++
      }
      progress?.(index + 1, jobs.length)
      // The first scan can take a while; keep what it has read if Orca quits midway.
      if (unsaved >= SAVE_EVERY_FILES) {
        await this.save()
        unsaved = 0
      }
    }
    if (unsaved > 0) {
      await this.save()
    }
    return changed
  }

  /** Every file's buckets added up, keyed `agent \t day \t model \t cwd \t L|P`. */
  totals(): Map<string, Totals> {
    if (this.merged) {
      return this.merged
    }
    // Of a session's copies (a file that moved or was compressed), the one with most responses.
    const responses = (entry: FileEntry): number =>
      Object.values(entry.buckets).reduce((sum, totals) => sum + totals[5], 0)
    const chosen = new Map<string, FileEntry>()
    for (const [path, entry] of Object.entries(this.data.files)) {
      const id = entry.id ? `${entry.agent}:${entry.id}` : path
      const current = chosen.get(id)
      if (!current || responses(entry) > responses(current)) {
        chosen.set(id, entry)
      }
    }
    const merged = new Map<string, Totals>()
    for (const entry of chosen.values()) {
      for (const [key, totals] of Object.entries(entry.buckets)) {
        const full = `${entry.agent}\t${key}`
        const sum = merged.get(full)
        if (sum) {
          totals.forEach((value, i) => (sum[i] += value))
        } else {
          merged.set(full, [...totals])
        }
      }
    }
    this.merged = merged
    return merged
  }

  private async readLog(source: LineSource, path: string): Promise<boolean> {
    const info = await stat(path)
    const size = info.size
    const mtime = Math.trunc(info.mtimeMs)
    const previous = this.data.files[path]
    if (previous && previous.size === size && previous.mtime === mtime) {
      return false
    }
    const compressed = /\.zstd?$/.test(path)
    const restart = !previous || compressed || size < previous.offset
    // Work on a copy: a read that fails midway must not leave half its lines counted.
    const entry: FileEntry = restart
      ? { agent: source.agent, id: source.identity?.(path), size, mtime, offset: 0, state: {}, buckets: {} }
      : structuredClone(previous)
    await source.prepare?.(path, entry.state)
    const onLine = (line: Buffer): void => {
      if (!source.hints.some((hint) => line.includes(hint))) {
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line.toString('utf8'))
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return
      }
      for (const event of source.parse(parsed as Record<string, unknown>, entry.state, path)) {
        addEvent(entry.buckets, event, entry.state.cwd)
      }
    }
    try {
      entry.offset = await readLines(path, entry.offset, compressed, onLine)
    } catch (error) {
      // An agent may still be writing a compressed log; keep what decoded.
      if (!compressed) {
        throw error
      }
    }
    if (compressed) {
      entry.offset = 0
    }
    entry.size = size
    entry.mtime = mtime
    this.data.files[path] = entry
    return true
  }

  private async readWhole(source: WholeSource): Promise<boolean> {
    const signature = await source.signature()
    const key = `${source.agent}:${source.path()}`
    if (!signature || this.data.files[key]?.signature === signature) {
      return false
    }
    const entry: FileEntry = { agent: source.agent, size: 0, mtime: 0, offset: 0, signature, state: {}, buckets: {} }
    for (const event of await source.read()) {
      addEvent(entry.buckets, event, undefined)
    }
    this.data.files[key] = entry
    return true
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.data))
    await rename(temporary, this.path)
  }
}
