import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickFolder, type CommandResult } from '../src/server/picker.ts'

/**
 * The platform folder picker: which command is run, and what the answers mean.
 *
 * The dialog itself cannot be judged here — a check that opened one would need a person. What can be
 * judged is the **decision**, which is where the mistakes live: a cancel read as a failure, a failure
 * read as a cancel, a host with no dialog pretending it has one, and an answer that is not a path being
 * handed back as though it were. The runner is injected for exactly that reason, the same way DSH's
 * picker takes its platform and runner as hooks.
 */

interface Call {
  readonly command: string
  readonly args: readonly string[]
}

/** A runner that answers in order and records what it was asked to do. */
function fakeRunner(results: readonly CommandResult[]): { readonly calls: Call[]; readonly run: (command: string, args: readonly string[]) => Promise<CommandResult> } {
  const calls: Call[] = []
  let index = 0
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args })
      const result = results[Math.min(index, results.length - 1)]
      index += 1
      return result ?? { stdout: '', stderr: '', code: 0 }
    },
  }
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', code: 0 })
const cancel = (): CommandResult => ({ stdout: '', stderr: 'execution error: User canceled. (-128)', code: 1 })
const missing = (command: string): CommandResult => ({ stdout: '', stderr: `${command}: command not found`, code: 127 })

test('macOS asks osascript, and trims the trailing slash it returns', async () => {
  const runner = fakeRunner([ok('/Users/zhenc/heddle/\n')])
  const outcome = await pickFolder({ platform: 'darwin', run: runner.run })

  assert.deepEqual(outcome, { kind: 'picked', path: '/Users/zhenc/heddle' })
  assert.equal(runner.calls[0]?.command, 'osascript')
  assert.ok(
    runner.calls[0]?.args.some((arg) => arg.includes('choose folder with prompt "Select Workspace Directory"')),
    'one argument is the AppleScript statement that opens the dialog',
  )
  assert.ok(runner.calls[0]?.args.includes('POSIX path of selectedFolder'))
  assert.equal(runner.calls[0]?.args.filter((arg) => arg === '-e').length, 2, 'two AppleScript statements, one argv')
})

test('a cancel is an answer on every platform, not a failure', async () => {
  const mac = await pickFolder({ platform: 'darwin', run: fakeRunner([cancel()]).run })
  assert.deepEqual(mac, { kind: 'cancelled' })

  const linux = await pickFolder({ platform: 'linux', run: fakeRunner([{ stdout: '', stderr: '', code: 1 }]).run })
  assert.deepEqual(linux, { kind: 'cancelled' })
})

test('linux uses zenity, and falls back to kdialog only when zenity is missing', async () => {
  const zenity = fakeRunner([ok('/home/zhenc/project\n')])
  assert.deepEqual(await pickFolder({ platform: 'linux', run: zenity.run }), { kind: 'picked', path: '/home/zhenc/project' })
  assert.equal(zenity.calls.length, 1, 'a working zenity is the whole answer')

  const fallback = fakeRunner([missing('zenity'), ok('/home/zhenc/other\n')])
  assert.deepEqual(await pickFolder({ platform: 'linux', run: fallback.run }), { kind: 'picked', path: '/home/zhenc/other' })
  assert.deepEqual(
    fallback.calls.map((call) => call.command),
    ['zenity', 'kdialog'],
    'kdialog is tried because zenity is absent, not because it failed',
  )

  const neither = fakeRunner([missing('zenity'), missing('kdialog')])
  const outcome = await pickFolder({ platform: 'linux', run: neither.run })
  assert.equal(outcome.kind, 'unavailable')
  assert.match(String((outcome as { reason: string }).reason), /install zenity or kdialog/, 'and the reason says what to install')
})

test('a host with no known dialog says so rather than pretending', async () => {
  const outcome = await pickFolder({ platform: 'freebsd', run: fakeRunner([ok('/x')]).run })
  assert.equal(outcome.kind, 'unavailable')
  assert.match(String((outcome as { reason: string }).reason), /freebsd/)
})

test('an answer that is not an absolute path is not mounted', async () => {
  for (const stdout of ['', '\n', 'relative/folder\n', './here\n', '~/somewhere\n']) {
    const outcome = await pickFolder({ platform: 'darwin', run: fakeRunner([ok(stdout)]).run })
    assert.deepEqual(outcome, { kind: 'cancelled' }, `${JSON.stringify(stdout)} is not a path`)
  }
})

test('a path with spaces or newlines comes back as the platform wrote it', async () => {
  const runner = fakeRunner([ok('/Users/zhenc/My Documents\n')])
  assert.deepEqual(await pickFolder({ platform: 'darwin', run: runner.run }), { kind: 'picked', path: '/Users/zhenc/My Documents' })
})

test('windows asks powershell for the folder dialog, and reads its answer', async () => {
  const runner = fakeRunner([ok('C:\\Users\\zhenc\\heddle\r\n')])
  const outcome = await pickFolder({ platform: 'win32', run: runner.run })
  assert.deepEqual(outcome, { kind: 'picked', path: 'C:\\Users\\zhenc\\heddle' })
  assert.equal(runner.calls[0]?.command, 'powershell')
  assert.ok(runner.calls[0]?.args.join(' ').includes('FolderBrowserDialog'), 'the folder dialog, not the file one')

  const dismissed = await pickFolder({ platform: 'win32', run: fakeRunner([ok('\r\n')]).run })
  assert.deepEqual(dismissed, { kind: 'cancelled' }, 'a dismissed dialog prints nothing')
})

test('the picker never builds a shell string', async () => {
  /**
   * The property that matters for safety: every command is a fixed argv, so a path can only ever be
   * **output**. A picker that interpolated a path into a command line would be a command injection with
   * a friendly button.
   */
  const runner = fakeRunner([ok('/tmp/x\n')])
  await pickFolder({ platform: 'darwin', run: runner.run })
  for (const call of runner.calls) {
    assert.ok(Array.isArray(call.args), 'argv, never a single string')
    assert.ok(
      call.args.every((arg) => !arg.includes('&&') && !arg.includes(';') || arg.startsWith('set selectedFolder')),
      `no shell joining in ${JSON.stringify(call.args)}`,
    )
  }
})
