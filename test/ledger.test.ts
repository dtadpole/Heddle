import assert from 'node:assert/strict'
import { test } from 'node:test'

import { projectLedger } from '../src/server/ledger.ts'

/**
 * Unit tests for the Trajectory ledger.
 *
 * The verifier judges what a browser draws; these judge the projection underneath it, which is where the
 * three rules that a reader would believe live: an in-flight record has no duration, an unreported number is
 * absent rather than zero, and a duration comes from the record's own events.
 */

const event = (seq, at, rest) => ({ seq, at, ...rest })

test('one prompt becomes one turn with its steps, and the records are grouped under them', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'session/created', cwd: '/tmp' }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'what is a heddle?' }] } }),
    event(3, '2026-10-11T10:00:00.100Z', { type: 'model/request', messages: 1, estimatedTokens: 1200, endpoint: 'x', tools: ['bash'] }),
    event(4, '2026-10-11T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'thinking' } }),
    event(5, '2026-10-11T10:00:01.000Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the part of a loom' } }),
    event(6, '2026-10-11T10:00:01.500Z', { type: 'assistant/completed', text: 'the part of a loom', finishReason: 'stop', rounds: 1 }),
    event(7, '2026-10-11T10:00:01.500Z', { type: 'turn/completed', rounds: 1 }),
  ])

  assert.equal(ledger.turns.length, 1, 'one turn')
  assert.equal(ledger.turns[0].steps.length, 1, 'and one step for one request')
  const kinds = ledger.turns[0].steps[0].records.map((record) => record.kind)
  /**
   * The trailing `system` record is the settled answer's own summary — its finish reason and round count.
   * It is a record rather than a decoration because the ledger is where a reader looks for why a step ended
   * the way it did.
   */
  assert.deepEqual(kinds, ['user', 'system', 'reasoning', 'assistant', 'system'], 'the records are grouped in order')
  assert.match(ledger.turns[0].steps[0].records[4].text, /finish:/, 'the last one says how the step ended')
  assert.equal(ledger.turns[0].steps[0].records[0].text, 'what is a heddle?', 'the prompt is the turn opener')
  assert.match(ledger.turns[0].steps[0].records[1].text, /1200|message/, 'the request record carries what the request said')
})

test('a turn and its step get durations, and a step with no end gets none', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:02.000Z', { type: 'assistant/completed', text: 'done' }),
    event(4, '2026-10-11T10:00:02.000Z', { type: 'turn/completed', rounds: 1 }),
  ])
  assert.equal(ledger.turns[0].durationMs, 2000, 'the turn measured two seconds')
  assert.equal(ledger.turns[0].steps[0].durationMs, 2000, 'and so did its step')
})

test('an unfinished stream is marked in flight and carries no duration', () => {
  /**
   * The rule DSH states as "in-flight records show a start marker without inventing elapsed time". It covers a
   * killed run and a stream still arriving, and the field is what a renderer needs to avoid printing a
   * duration for something that has not finished.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:00.500Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'half an ans' } }),
  ])
  const partial = ledger.turns[0].steps[0].records.find((record) => record.kind === 'assistant')
  assert.ok(partial, 'the partial answer is recorded')
  assert.equal(partial.inFlight, true, 'and marked in flight')
  assert.equal(partial.durationMs, undefined, 'with no duration invented for it')
  assert.equal(partial.startedAt, '2026-10-11T10:00:00.500Z', 'but with the start it does know')
  assert.equal(ledger.inFlight, 1, 'and the ledger counts it')
})

test('an unreported token count is absent, not zero', () => {
  /**
   * `inputTokens: 0` says a request cost nothing. "Not reported" is a different claim, and a renderer that
   * cannot tell them apart will print the false one.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-11T10:00:01.000Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'answer' }),
  ])
  const answer = ledger.turns[0].steps[0].records.find((record) => record.kind === 'assistant')
  assert.equal(answer.usage, undefined, 'no usage object at all rather than zeroes')
  assert.deepEqual(ledger.tokens, {}, 'and the totals are empty rather than zero')
})

test('provider usage is kept apart from the harness estimate', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 900 }),
    event(3, '2026-10-11T10:00:00.500Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'assistant/chunk', chunk: { type: 'done', usage: { inputTokens: 812, outputTokens: 7 } } }),
    event(5, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'answer' }),
  ])
  const records = ledger.turns[0].steps[0].records
  const request = records.find((record) => record.label === 'request')
  const answer = records.find((record) => record.kind === 'assistant')
  assert.equal(request.usageSource, 'estimated', 'the request record is the harness estimate')
  assert.equal(answer.usageSource, 'provider', 'and the answer holds what the provider reported')
  assert.deepEqual(answer.usage, { inputTokens: 812, outputTokens: 7 })
  assert.deepEqual(ledger.tokens, { input: 812, output: 7, estimated: 900 }, 'the totals keep the two apart')
})

test('a tool call and its result are separate records, and a refusal says so', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'run it' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:00.100Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } }),
    event(4, '2026-10-11T10:00:00.200Z', { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '/Users/zhenc' }] } }),
    event(5, '2026-10-11T10:00:00.300Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c2', name: 'write_file', arguments: '{"path":"/etc/x"}' } }),
    event(6, '2026-10-11T10:00:00.400Z', { type: 'message', message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'error: outside the sandbox root' }] } }),
  ])
  const records = ledger.turns[0].steps[0].records
  const call = records.find((record) => record.label === '→ bash')
  assert.ok(call, 'the call is identified by its tool name')
  assert.equal(call.text, '{"command":"pwd"}', 'and holds the arguments exactly as recorded')
  assert.ok(records.some((record) => record.kind === 'tool' && record.text === '/Users/zhenc'), 'the result is its own record')
  assert.ok(
    records.some((record) => record.label === 'tool (refused)' && record.note !== undefined),
    'and a refused call is marked rather than looking like a result',
  )
})

test('records that belong to no turn are kept, not dropped', () => {
  /**
   * A ledger that silently ignores what it does not recognise cannot be trusted to be complete. This is the
   * property that makes the projection safe to extend: an unknown event shows up as a system record.
   */
  const ledger = projectLedger([event(1, '2026-10-11T10:00:00.000Z', { type: 'something/new', detail: 7 })])
  assert.equal(ledger.turns.length, 0, 'no turn was opened')
  assert.equal(ledger.loose.length, 1, 'and the event is kept as a loose record')
  assert.equal(ledger.loose[0].label, 'something/new', 'named by its own type')
})

test('projecting the same events twice gives the same ledger', () => {
  const events = [
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'done' }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'turn/completed', rounds: 1 }),
  ]
  assert.deepEqual(projectLedger(events), projectLedger(events), 'a pure projection has no state to drift')
})
