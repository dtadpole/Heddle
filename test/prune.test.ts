import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ContentPart, Message } from '../src/llm/types.ts'
import type { SessionHandle } from '../src/session/store.ts'
import type { PrunableStore } from '../src/context/prune.ts'
import { PRUNE_HEAD_CHARS, PRUNE_MARKER, PRUNE_TAIL_CHARS, PRUNE_THRESHOLD_CHARS, ToolResultPruner, pruneText } from '../src/context/prune.ts'

/**
 * The pruner's cases.
 *
 * The store is a fake rather than a real `SessionStore` on purpose: what is being
 * pinned is the pruner's walk and what it appends, and a real store would add a
 * transcript on disk to every assertion. The fake shadows a `surfaceOp` the way the log
 * does — the replaced node leaves the surface and the replacement takes its place — so
 * a second pass sees what a resumed session would see.
 */

/** What the fake store recorded, so a case can assert on order and payload. */
interface AppendCall {
  readonly event: { readonly type: string; readonly [key: string]: unknown }
  readonly options?: {
    readonly surfaceOp?: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
    readonly sourceEventSeqs?: readonly number[]
  }
}

const handle: SessionHandle = {
  id: 'session-prune-test',
  dir: '/tmp/heddle-prune-test',
  transcript: '/tmp/heddle-prune-test/session.jsonl',
}

/** A surface in a `Map`, with an `append` that applies `surfaceOp` as a shadow. */
class FakeStore implements PrunableStore {
  readonly appends: AppendCall[] = []
  private readonly messages = new Map<number, Message>()
  private readonly nodes: number[] = []
  private next = 0

  /** Put one message on the surface, and say what seq it landed at. */
  add(message: Message): number {
    const seq = this.next
    this.next += 1
    this.messages.set(seq, message)
    this.nodes.push(seq)
    return seq
  }

  surface(): { readonly nodes: readonly number[] } {
    return { nodes: [...this.nodes] }
  }

  deriveNode(handle: SessionHandle, seq: number): Message | null {
    return this.messages.get(seq) ?? null
  }

  append(
    handle: SessionHandle,
    event: { readonly type: string; readonly [key: string]: unknown },
    options?: AppendCall['options'],
  ): { readonly seq: number } {
    this.appends.push(options === undefined ? { event } : { event, options })
    const seq = this.next
    this.next += 1
    const op = options?.surfaceOp
    if (op !== undefined) {
      for (let index = this.nodes.length - 1; index >= 0; index -= 1) {
        const node = this.nodes[index]
        if (node !== undefined && node >= op.startSeq && node <= op.endSeq) this.nodes.splice(index, 1)
      }
      const message = event['message'] as Message | undefined
      if (message !== undefined) this.messages.set(seq, message)
      this.nodes.push(seq)
    }
    return { seq }
  }
}

/** A text part of `length` characters, which is what every measured case varies. */
function text(length: number, character: string): ContentPart {
  return { type: 'text', text: character.repeat(length) }
}

test('a result within the threshold is untouched and nothing is appended', () => {
  const store = new FakeStore()
  const original: Message = { role: 'tool', toolCallId: 'call-1', content: [text(64, 's')] }
  const seq = store.add(original)

  const result = new ToolResultPruner().pruneSession(store, handle)

  assert.deepEqual(result, { pruned: 0, charsRemoved: 0 })
  assert.equal(store.appends.length, 0)
  assert.deepEqual(store.surface().nodes, [seq])
  assert.deepEqual(store.deriveNode(handle, seq), original)
})

test('an oversized result lands as two appends: the shadow price, then the replacement', () => {
  const store = new FakeStore()
  const oversized = 'H'.repeat(9000)
  const kept: ContentPart = { type: 'reasoning', text: 'a block that must keep its place' }
  const small = text(2000, 'T')
  const original: Message = {
    role: 'tool',
    toolCallId: 'call-7',
    content: [{ type: 'text', text: oversized }, kept, small],
  }
  const seq = store.add(original)
  const estimate = (message: Message): number => 3 * message.content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0)

  const result = new ToolResultPruner({}, estimate).pruneSession(store, handle)

  const removed = oversized.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
  const prunedText = `${oversized.slice(0, PRUNE_HEAD_CHARS)}${PRUNE_MARKER.replace('N', String(removed))}${oversized.slice(-PRUNE_TAIL_CHARS)}`
  assert.equal(result.pruned, 1)
  assert.equal(result.charsRemoved, oversized.length - prunedText.length)

  assert.equal(store.appends.length, 2)
  const [price, replacement] = store.appends
  assert.ok(price !== undefined && replacement !== undefined, 'expected exactly the price and the replacement')

  assert.equal(price.event.type, 'compaction/prune')
  assert.deepEqual(price.event['shadowedRange'], { start: seq, end: seq })
  assert.deepEqual(price.event['shadowedSeqs'], [seq])

  assert.equal(replacement.event.type, 'message')
  assert.deepEqual(replacement.event['message'], {
    role: 'tool',
    toolCallId: 'call-7',
    content: [{ type: 'text', text: prunedText }, kept, small],
  })
  assert.deepEqual(replacement.options?.surfaceOp, { op: 'replace', startSeq: seq, endSeq: seq })
  assert.deepEqual(replacement.options?.sourceEventSeqs, [seq])

  // The surface now holds only the replacement, which is what a second pass reads.
  assert.equal(store.surface().nodes.length, 1)
  assert.notEqual(store.surface().nodes[0], seq)
})

test('the shadow price is the estimator’s price of the original, not of the replacement', () => {
  const store = new FakeStore()
  const original: Message = { role: 'tool', toolCallId: 'call-2', content: [text(9000, 'p')] }
  const seq = store.add(original)
  // Deliberately not the default meter, and multiplied so the number cannot be
  // confused with a character count.
  const estimate = (message: Message): number => 3 * message.content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0)

  new ToolResultPruner({}, estimate).pruneSession(store, handle)

  const price = store.appends[0]
  const replacement = store.appends[1]
  assert.ok(price !== undefined && replacement !== undefined)
  assert.equal(price.event['shadowedTokenCount'], 3 * 9000)

  const replaced = replacement.event['message'] as Message
  assert.notEqual(price.event['shadowedTokenCount'], estimate(replaced))
  assert.ok(estimate(replaced) < 3 * 9000)
})

test('a second pass over the already-pruned surface prunes nothing', () => {
  const store = new FakeStore()
  // Two over-threshold parts with one under it: after the first pass each part is
  // under the threshold individually while their sum is still over it, which is the
  // case where a replacement must not be appended because nothing would change.
  const original: Message = { role: 'tool', content: [{ type: 'text', text: 'x'.repeat(9000) }, text(4000, 'y')] }
  store.add(original)
  const pruner = new ToolResultPruner()

  const first = pruner.pruneSession(store, handle)
  assert.equal(first.pruned, 1)
  assert.equal(store.appends.length, 2)
  const afterFirst = store.surface().nodes

  const second = pruner.pruneSession(store, handle)

  assert.deepEqual(second, { pruned: 0, charsRemoved: 0 })
  assert.equal(store.appends.length, 2)
  assert.deepEqual(store.surface().nodes, afterFirst)
})

test('a non-tool node is never pruned', () => {
  const store = new FakeStore()
  const original: Message = { role: 'user', content: [text(9000, 'u')] }
  const seq = store.add(original)

  const result = new ToolResultPruner().pruneSession(store, handle)

  assert.deepEqual(result, { pruned: 0, charsRemoved: 0 })
  assert.equal(store.appends.length, 0)
  assert.deepEqual(store.deriveNode(handle, seq), original)
})

test('the constructor refuses a budget whose head and tail do not fit inside the trigger', () => {
  assert.throws(
    () => new ToolResultPruner({ thresholdChars: 100, headChars: 90, tailChars: 30 }),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'expected a plain Error')
      // Every number is named, so the message alone says which one to change.
      assert.match(error.message, /headChars \(90\)/)
      assert.match(error.message, new RegExp(`marker \\(${PRUNE_MARKER.length}\\)`))
      assert.match(error.message, /tailChars \(30\)/)
      assert.match(error.message, /thresholdChars \(100\)/)
      return true
    },
  )
  // The defaults fit, so the same construction with no arguments must not throw.
  assert.doesNotThrow(() => new ToolResultPruner())
})

test('pruneText leaves text at exactly the threshold alone and names what it cut', () => {
  const exact = 'e'.repeat(PRUNE_THRESHOLD_CHARS)
  assert.deepEqual(pruneText(exact), { text: exact, pruned: false })

  const over = 'o'.repeat(PRUNE_THRESHOLD_CHARS + 1)
  const removed = over.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
  const result = pruneText(over)
  assert.equal(result.pruned, true)
  assert.equal(result.text, `${over.slice(0, PRUNE_HEAD_CHARS)}${PRUNE_MARKER.replace('N', String(removed))}${over.slice(-PRUNE_TAIL_CHARS)}`)
})
