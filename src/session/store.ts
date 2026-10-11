import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Chunk, ContentPart } from '../llm/types.ts'

/**
 * The session store.
 *
 * Modelled on `@deepseek-ai/dsh-session`: a session is an **event log**, not a
 * mutable conversation object. Each event is a line in one JSONL file, and the
 * file is opened for append, so a turn that is interrupted leaves a start with no
 * end — which is exactly what an interruption looks like and what a
 * rewrite-the-whole-file store cannot show.
 *
 * The shape differs from DSH's in one way, and for a measured reason. DSH keeps
 * its store under the workspace and writes through its own persistence plugins
 * because it must survive a machine and a UI layer; this one writes one directory
 * per session under `$HEDDLE_HOME/sessions`, which is what a single-process
 * harness needs and what makes the store something a person can read with `cat`.
 *
 * A session id is the directory's name; the transcript is `session.jsonl`; a
 * small `meta.json` records what the session is for, so a listing does not need
 * to parse every transcript.
 */

/** Identifies one session; the directory name under the store root. */
export type SessionId = string

/** One entry in the log. `seq` is monotonic within a session. */
export interface SessionEvent {
  readonly seq: number
  readonly at: string
  readonly type: string
  readonly [key: string]: unknown
}

/** What a caller gets back when it opens a session. */
export interface SessionHandle {
  readonly id: SessionId
  readonly dir: string
  /** Where the transcript is; a caller may cite it. */
  readonly transcript: string
}

/** A message as it is recorded, which is the shape a request needs too. */
export interface RecordedMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: readonly ContentPart[]
  /** Present on a `tool` message: which call this answers. */
  readonly toolCallId?: string
}

/** One session's metadata, written once and corrected rarely. */
export interface SessionMeta {
  readonly id: SessionId
  readonly created: string
  readonly cwd: string
  readonly endpoint?: string
  readonly model?: string
  readonly title?: string
  readonly turns: number
}

/** The default root, overridable so a check can use a scratch directory. */
export function defaultSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'sessions')
}

/**
 * Where the transcript can be read.
 *
 * A session records under the directory its process ran in, and the record names
 * that directory, so the caller can decide whether a session belongs to them
 * rather than guessing from the store's shape.
 */
export class SessionStore {
  readonly root: string

  constructor(root: string = defaultSessionRoot()) {
    // `~` is expanded because the profile writes `~/.heddle/sessions` and a
    // literal `~` directory beside the project is the wrong place to put it.
    this.root = resolve(root.startsWith('~') ? join(homedir(), root.slice(1)) : root)
  }

  /** Create a session directory and its metadata. */
  create(options: { readonly cwd?: string; readonly endpoint?: string; readonly model?: string; readonly title?: string } = {}): SessionHandle {
    const id = `session-${randomUUID()}`
    const dir = join(this.root, id)
    mkdirSync(dir, { recursive: true })
    const handle: SessionHandle = { id, dir, transcript: join(dir, 'session.jsonl') }
    writeFileSync(
      join(dir, 'meta.json'),
      `${JSON.stringify(
        {
          id,
          created: new Date().toISOString(),
          cwd: options.cwd ?? process.cwd(),
          ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.title !== undefined ? { title: options.title } : {}),
          turns: 0,
        },
        null,
        2,
      )}\n`,
    )
    appendFileSync(handle.transcript, '')
    this.append(handle, { type: 'session/created', cwd: options.cwd ?? process.cwd() })
    return handle
  }

  /** Open an existing session by id, or by the newest one when `id` is omitted. */
  open(id?: SessionId): SessionHandle | null {
    if (id !== undefined) {
      const dir = join(this.root, id)
      try {
        readFileSync(join(dir, 'meta.json'), 'utf8')
      } catch {
        return null
      }
      return { id, dir, transcript: join(dir, 'session.jsonl') }
    }
    const newest = this.list()[0]
    return newest === undefined ? null : this.open(newest.id)
  }

  /** Sessions newest first, from the directory names and their metadata. */
  list(): readonly SessionMeta[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    for (const name of names) {
      if (!name.startsWith('session-')) continue
      try {
        metas.push(JSON.parse(readFileSync(join(this.root, name, 'meta.json'), 'utf8')) as SessionMeta)
      } catch {
        continue
      }
    }
    return metas.sort((left, right) => (left.created < right.created ? 1 : -1))
  }

  /**
   * Append one event.
   *
   * Synchronous on purpose: an event must be on disk before the thing it
   * describes happens, or an interruption loses precisely the event that says
   * what the run was doing. This is the same reasoning as "write at the event,
   * not at the end of it" in the runtime ledger.
   */
  append(handle: SessionHandle, event: Omit<SessionEvent, 'seq' | 'at'> & { readonly type: string }): SessionEvent {
    const seq = this.count(handle)
    const record: SessionEvent = { seq, at: new Date().toISOString(), ...event }
    appendFileSync(handle.transcript, `${JSON.stringify(record)}\n`)
    return record
  }

  /** How many events a session holds, which is also the next event's `seq`. */
  count(handle: SessionHandle): number {
    try {
      return readFileSync(handle.transcript, 'utf8').split('\n').filter((line) => line.length > 0).length
    } catch {
      return 0
    }
  }

  /** Every event, parsed. A line that cannot be parsed is reported, not skipped. */
  read(handle: SessionHandle): readonly SessionEvent[] {
    const text = readFileSync(handle.transcript, 'utf8')
    const events: SessionEvent[] = []
    for (const [index, line] of text.split('\n').entries()) {
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch (error) {
        throw new Error(`${handle.transcript}:${index + 1} is not valid JSON — ${(error as Error).message}`)
      }
    }
    return events
  }

  /** Record a message and keep the metadata's turn count honest. */
  message(handle: SessionHandle, message: RecordedMessage): SessionEvent {
    const event = this.append(handle, { type: 'message', message })
    if (message.role === 'user') this.bumpTurns(handle)
    return event
  }

  /**
   * Record the assistant's answer from the chunk stream.
   *
   * One event per chunk rather than one per answer, for the same reason the
   * ledger is written at the event: a killed run should read as a partial answer,
   * not as no answer. The `assistant/completed` event that follows is what says
   * the answer finished.
   */
  assistantChunk(handle: SessionHandle, chunk: Chunk): void {
    this.append(handle, { type: 'assistant/chunk', chunk })
  }

  /** Record which model call produced the answer, before it is made. */
  modelRequest(handle: SessionHandle, request: { readonly endpoint: string; readonly model?: string; readonly messages: number; readonly tools: readonly string[] }): void {
    this.append(handle, { type: 'model/request', ...request })
  }

  /** Everything a resumed session needs to rebuild the request. */
  messages(handle: SessionHandle): readonly RecordedMessage[] {
    const messages: RecordedMessage[] = []
    for (const event of this.read(handle)) {
      if (event.type === 'message') {
        const message = event.message as RecordedMessage | undefined
        if (message) messages.push(message)
      } else if (event.type === 'assistant/chunk') {
        const chunk = event.chunk as Chunk | undefined
        if (chunk?.type === 'text-delta') {
          const last = messages[messages.length - 1]
          if (last?.role === 'assistant') {
            messages[messages.length - 1] = {
              role: 'assistant',
              content: [...last.content, { type: 'text', text: chunk.text }],
            }
          } else {
            messages.push({ role: 'assistant', content: [{ type: 'text', text: chunk.text }] })
          }
        } else if (chunk?.type === 'tool-call') {
          messages.push({
            role: 'assistant',
            content: [{ type: 'tool-call', id: chunk.id, name: chunk.name, arguments: chunk.arguments }],
          })
        }
      }
    }
    return messages
  }

  /** The plain text of a session's last assistant answer. */
  lastAnswer(handle: SessionHandle): string {
    const events = this.read(handle)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'assistant/completed') return String(event.text ?? '')
    }
    return ''
  }

  private bumpTurns(handle: SessionHandle): void {
    const path = join(handle.dir, 'meta.json')
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8')) as SessionMeta
      const updated: SessionMeta = { ...meta, turns: (meta.turns ?? 0) + 1 }
      writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`)
    } catch {
      // A session without readable metadata is still a usable session; the count
      // is a convenience and losing it must not lose the turn.
    }
  }
}
