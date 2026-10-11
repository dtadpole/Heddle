import assert from 'node:assert/strict'
import { test } from 'node:test'

import { tokenFormPage, transcriptTurns } from '../src/server/web.ts'

/**
 * Unit tests for the Web UI's two pure pieces.
 *
 * The verifiers judge the delivered page in a browser, which is the only way to see a rendering failure.
 * These judge the two decisions **underneath** it — how a recorded session folds into display turns, and
 * which refusal a caller is shown — because both have rules that are easy to get subtly wrong and cheap to
 * state here: the fold must read deltas rather than completions, and the two refusals must not read alike.
 */

test('a tool call keeps its name as a label, apart from its arguments', () => {
  /**
   * The label is what a collapsed block shows. Deriving it on the client would mean parsing it back out of
   * the string this function just built, so it is carried as a field.
   */
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } },
  ])
  assert.deepEqual(turns, [{ kind: 'tool', label: '→ bash', text: '{"command":"pwd"}' }])
})

test('reasoning keeps its own kind, because a reader wants it apart from the answer', () => {
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'thinking' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } },
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.kind, turn.text]),
    [
      ['reasoning', 'thinking'],
      ['assistant', 'answer'],
    ],
  )
})

test('a completed turn is not read as well as its deltas, or every answer would appear twice', () => {
  /**
   * The log records both for one turn: the deltas as they arrived, and the settled `assistant/completed`.
   * Reading both is the mistake this test exists to prevent, and it is invisible in a transcript with one
   * short answer because the duplicate looks like a second paragraph.
   */
  const events = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'ask' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the answer' } },
    { type: 'assistant/completed', text: 'the answer', reasoning: 'why' },
    { type: 'turn/completed', turns: 1 },
  ]
  const turns = transcriptTurns(events)
  assert.equal(turns.filter((turn) => turn.text === 'the answer').length, 1, 'the answer appears once')
  assert.equal(turns.length, 2, 'the user line and the answer, and nothing else')
})

test('a tool result is a tool turn, and an error result is marked denied', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'output' }] } },
    { type: 'message', message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'error: refused' }] } },
  ])
  assert.deepEqual(
    turns.map((turn) => turn.kind),
    ['tool', 'denied'],
  )
})

test('events that are not a display turn are ignored rather than rendered as blanks', () => {
  const turns = transcriptTurns([
    { type: 'session/created', cwd: '/tmp' },
    { type: 'model/request', messages: 2 },
    { type: 'assistant/chunk', chunk: { type: 'done' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'kept' }] } },
  ])
  assert.deepEqual(turns, [{ kind: 'user', text: 'kept' }])
})

test('a refusal with no token and a refusal with a stale one say different things', () => {
  /**
   * They are different situations and a person acts differently on each: one has never had a token, the
   * other had one that stopped working. The page has to tell them apart, and it has to carry the form — the
   * earlier version was a sentence with no way forward, which turned every restart into an outage.
   */
  const fresh = tokenFormPage()
  const stale = tokenFormPage({ stale: true })

  assert.match(fresh, /token is required/i, 'the no-token page says a token is required')
  assert.doesNotMatch(fresh, /not the current one/i)
  assert.match(stale, /not the current one/i, 'the stale page says the token is stale')
  assert.doesNotMatch(stale, /is required for this page/i)

  for (const [label, html] of [
    ['no token', fresh],
    ['stale token', stale],
  ]) {
    assert.match(html, /<form method="get" action="\/"/, `${label}: carries the form`)
    assert.match(html, /name="token"/, `${label}: has somewhere to paste a token`)
    assert.match(html, /web\.log/, `${label}: says where the current token is`)
    assert.match(html, /^<!doctype html>/i, `${label}: is a document rather than a sentence`)
  }
})
