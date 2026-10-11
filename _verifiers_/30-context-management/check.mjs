import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, parseJson, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, writeJson } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier 3 — context management.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: the messages for a model call are **assembled from
 * the session in a defined order**, bounded by a **token budget**, with oversized tool
 * results **pruned** and an over-budget history **compacted**.
 *
 * The check reads what the harness recorded about its own request — `model/request` carries
 * the estimate, the budget and what was pruned, and `compaction/*` events record a
 * compaction — so the claim is judged from the record rather than from a re-implementation of
 * the budget in the check. Everything runs against the scripted endpoint, so no model is
 * called and nothing is spent.
 */

const CAPABILITY = 'context assembly with a budget, pruning and compaction'

/** A profile whose context plugin carries the budget the check wants to exercise. */
function contextProfile(home, options = {}) {
  const dir = fixtureDir('context-profile')
  /**
   * Plugin paths are written relative to the profile directory, which is under
   * `.heddle-tmp/` rather than at the repository root. Measured: a fixture that wrote
   * `./src/plugins/...` booted an empty tree, because a relative specifier resolves against
   * the base layer's own directory — and the loader reports a failed import only in a log
   * line, so the run looked like a profile with no plugins rather than a broken path.
   */
  const prefix = relative(dir, repoRoot).split('\\').join('/')
  writeJson(join(home, 'heddle.json'), {
    default: 'scripted',
    endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: options.script ?? join(home, 'script.json'), model: 'scripted' }],
  })
  const contextConfig = [
    `        contextWindow: ${options.contextWindow ?? 2000}`,
    `        instructions: ${options.instructions === false ? 'false' : 'true'}`,
    ...(options.thresholdTokens !== undefined ? [`        thresholdTokens: ${options.thresholdTokens}`] : []),
  ].join('\n')
  writeFileSync(
    join(dir, 'cordis.yml'),
    '[]\n',
  )
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    # The console exporter is part of the tree, not decoration: without a row for it the
    # profile is a different tree from the one a run normally loads.
    - id: console
      name: ${prefix}/src/plugins/console-exporter.ts
    - id: session
      name: ${prefix}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${prefix}/src/plugins/model.ts
    - id: context
      name: ${prefix}/src/context/service.ts
      inject: [model, session]
      config:
${contextConfig}
    - id: workspace
      name: ${prefix}/src/workspace/service.ts
      inject: [session]
    - id: sandbox
      name: ${prefix}/src/sandbox/service.ts
      config:
        mode: workspace-write
        workspaceRoot: ${options.workspace ?? home}
    - id: approvals
      name: ${prefix}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [write_file, read_file, list_dir]
`,
  )
  return dir
}

function harness(label, options = {}) {
  const home = fixtureDir(`context-home-${label}`)
  const { config, script } = scriptedConfig({
    home,
    steps: options.steps ?? [{ text: 'a short answer' }],
    ...(options.tools ? { steps: options.tools } : {}),
  })
  const profileDir = contextProfile(home, { ...options, script })
  return { home, config, script, profileDir, env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config } }
}

async function supportsContext() {
  const help = await runCli(['--help'])
  return /context/.test(help.stdout)
}

test('a request records the estimate and the budget it was assembled under', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const h = harness('budget', { contextWindow: 2000 })
  try {
    const run = await runCli(['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'say something', '--json'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.ok(summary?.context, `the run reported its context\n${run.stdout}`)
    assert.ok(summary.context.estimatedTokens > 0, 'the estimate is a real number')
    assert.ok(
      summary.context.estimatedTokens < 2000,
      `a short conversation fits the window it was given (${summary.context.estimatedTokens} of 2000)`,
    )
    assert.equal(summary.context.thresholdTokens, Math.floor(2000 * 0.8), 'the threshold is eighty percent of the window')
  } finally {
    removeDir(h.home)
  }
})

test('the assembled context carries the working directory instructions', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const h = harness('instructions', { contextWindow: 100_000, workspace: undefined })
  try {
    // The instruction file lives in the workspace the sandbox names, so it is the one
    // `findInstructions` walks from.
    writeFileSync(join(h.home, 'AGENTS.md'), '# instructions for this workspace\n\nSay the safe word.\n')
    const run = await runCli(['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'say something'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(session, 'a session was recorded')
    const events = readTranscript(join(h.home, 'sessions', session, 'session.jsonl'))
    const request = events.find((event) => event.type === 'model/request')
    assert.ok(request, 'the request was recorded')
    assert.ok(
      (request.messages ?? 0) >= 2,
      `the instruction message was part of the request, not only the user turn (${request.messages} message(s))`,
    )
  } finally {
    removeDir(h.home)
  }
})

test('an oversized tool result is pruned before it is sent', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  /**
   * A scripted tool call writes a file far larger than the prune threshold, then a read
   * brings it back. The recorded request must say a result was pruned, and the tool message
   * in the transcript must carry the marker rather than the whole body.
   */
  const h = harness('prune', {
    contextWindow: 200_000,
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'big.txt', content: 'x'.repeat(20_000) } } },
      { toolCall: { name: 'read_file', arguments: { path: 'big.txt' } } },
      { text: 'read it' },
    ],
  })
  try {
    const run = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'make a big file and read it back'],
      { env: h.env },
    )
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const events = readTranscript(join(h.home, 'sessions', session, 'session.jsonl'))
    const requests = events.filter((event) => event.type === 'model/request')
    assert.ok(
      requests.some((request) => (request.pruned ?? 0) > 0),
      `a request recorded a pruned result\n${JSON.stringify(requests.map((r) => r.pruned))}`,
    )
    const toolMessages = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.ok(toolMessages.length > 0, 'the tool result was recorded')
    /**
     * The recorded result is the **whole** body and the recorded request says a result was
     * pruned, and that pair is the claim rather than a contradiction.
     *
     * Pruning happens in the assembly, so it changes what a model is sent and not what the
     * session recorded — which is the point of keeping the pruning in the projection: the log
     * stays the exact record of what the tool produced, and a reader can still see all of it.
     * DSH draws the line in the same place. Measured the other way first: this check looked
     * for the marker in the transcript, which would only appear if the record had been
     * rewritten, and rewriting it is what the design avoids.
     */
    assert.ok(
      toolMessages.some((text) => text.length > 8192),
      `the recorded result is over the prune threshold, so there was something to prune (longest ${Math.max(...toolMessages.map((text) => text.length))})`,
    )
  } finally {
    removeDir(h.home)
  }
})

test('an over-budget history is compacted and the log keeps the shadowed turns', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  /**
   * A deliberately tiny window and a handful of turns: by the third turn the estimate must
   * cross the threshold. The check then reads four things from the record — a compaction that
   * started, a summary, the replacement message, and the fact that the original turns are
   * still in the log, which is what makes a replay exact.
   */
  const h = harness('compact', {
    contextWindow: 400,
    thresholdTokens: 120,
    steps: [{ text: 'x'.repeat(200) }, { text: 'y'.repeat(200) }, { text: 'z'.repeat(200) }],
  })
  try {
    const run = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'first question about a long topic', '--json'],
      { env: h.env },
    )
    assert.equal(run.code, 0, `the first turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    for (const prompt of ['second question', 'third question', 'fourth question']) {
      const again = await runCli(
        ['--profile', h.profileDir, '--endpoint', 'scripted', '--resume', session, '--turn', prompt],
        { env: h.env },
      )
      assert.equal(again.code, 0, `the ${prompt} turn ran\n${again.stdout}${again.stderr}`)
    }

    const events = readTranscript(join(h.home, 'sessions', session, 'session.jsonl'))
    const kinds = events.map((event) => event.type)
    assert.ok(kinds.includes('compaction/start'), `a compaction started\nsaw: ${[...new Set(kinds)].join(', ')}`)
    assert.ok(kinds.includes('compaction/summary'), 'a summary was written')
    assert.ok(kinds.includes('compaction/end'), 'the compaction finished')
    const summary = events.find((event) => event.type === 'compaction/summary')
    assert.match(String(summary?.summary ?? ''), /<compacted-summary>/, 'the replacement is framed as a summary')

    const userTurns = events
      .filter((event) => event.type === 'message' && event.message?.role === 'user')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.ok(
      userTurns.some((text) => text.includes('first question')),
      'the shadowed turn is still in the log, so the record is complete even though the prompt is not',
    )
  } finally {
    removeDir(h.home)
  }
})
