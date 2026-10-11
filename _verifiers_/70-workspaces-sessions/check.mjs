import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { decodeTranscript } from '../../src/session/transcript.ts'
import { fixtureDir, isolatedHome, parseJson, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier 7 — workspaces and sessions.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: **workspaces are folders with records, and sessions live
 * under a folder**, the way DSH does it.
 *
 * The part is judged from a user's seat rather than from the store's shape. A person who has run
 * two turns in two directories asks three questions: *where did my conversation go, which folder
 * does it belong to, and can I get back to it?* The checks answer those, and they read the
 * transcript on disk as well, because a listing that disagrees with the files is worse than no
 * listing.
 *
 * The association rule being judged is heddle's own, and it is the one the owner chose on 2026-10-11:
 * a session belongs to the workspace with the **longest root that is an ancestor of its working
 * directory**. Containment, not equality — so a session started in a subdirectory *is* a member of
 * the workspace above it, and the nearest registered root owns it when roots nest.
 *
 * The rest of the part is the navigation that rule makes possible, and it is stated in
 * [`../../SESSION_TREE.md`](../../SESSION_TREE.md): one folder holds one session, the folder's name is
 * the session's name, and the tree classifies each folder by the conventions repository's own rules
 * (`_type_` folders, kebab-case instances, plain containers). Those checks judge the **derivation**,
 * one level at a time, rather than a rendered page, because that is where the mechanism lives.
 *
 * Measured: three of the checks here changed when the owner reversed the equality rule — the
 * subdirectory check that asserted the old rule, and the "found again" check that assumed two runs in
 * one folder make two sessions. Both now assert the new model and say so, rather than being bent to
 * keep passing.
 */

const CAPABILITY = 'workspaces as folders with records, and sessions grouped under them'

/**
 * The second capability: the folder-bound session tree.
 *
 * Every check below this line judges a mechanism that does not exist yet, and each one reports
 * **unjudged** (`3`) rather than failing until it does — which is the honest verdict for a claim whose
 * subject is unbuilt, and the reason the part's own verdict moves to `3` rather than `0` the moment
 * these checks land. The marker is the `tree` command in the CLI's own help: the command cannot exist
 * without the derivation behind it, and if it exists but is wrong the checks run and report a failure,
 * which is the distinction that matters.
 */
const TREE_CAPABILITY = 'the folder-bound session tree, judged one level at a time'

async function supportsFolderTree() {
  const help = await runCli(['--help'])
  /**
   * The probe is the **command line** in the help, not the word.
   *
   * Measured: `/tree/` matched the help's own prose — "prints the loaded plugin tree" — so every check
   * below ran against a build with no `tree` command and reported thirteen failures, which is the one
   * verdict that must not be given for "this is not built".
   */
  return /^\s{2}tree\b/m.test(help.stdout)
}

function harness(label) {
  const home = isolatedHome(label)
  const work = fixtureDir(`session-work-${label}`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'a remembered answer' }] })
  return {
    home,
    work,
    config,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    /**
     * The project's own profile is named explicitly, and the session store is pointed at the fixture.
     *
     * Measured: a command run with `cwd` set to a fixture directory booted an empty tree, because the
     * profile is found beside the run — so the fixture passed `--config` with the repository's profile
     * rather than relying on the working directory to supply one. `--session-root` is the supported
     * way to keep the owner's store out of it.
     */
    args: ['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(home, 'sessions')],
  }
}

async function supportsCommands() {
  const help = await runCli(['--help'])
  return /workspaces/.test(help.stdout) && /sessions/.test(help.stdout)
}

/** The commands a check uses when it does not want the fixture's own profile to be found by cwd. */
function adminArgs(h, extra) {
  return ['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), ...extra]
}

/** Write a file, creating its directory, because a fixture tree is all directories and one file. */
function entry(path, text = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * A fixture shaped like the conventions repository, because that is what the tree has to classify.
 *
 * Every content folder carries its `INDEX.md` (the convention's one hard rule), a type folder holds
 * only its index and its instances, `_monitors_` is left empty on purpose — an empty type folder is
 * valid in the conventions and must render as such — and the two folders that must **not** appear are
 * a plumbing directory and a generated one.
 *
 * It **registers its own root** as well, because a tree is a view of the folders a person registered:
 * asking for the tree of an unregistered directory is refused on purpose, and a fixture that skipped
 * the registration would be judging the refusal rather than the classification.
 */
async function conventionsFixture(h) {
  const work = h.work
  entry(join(work, 'AGENTS.md'), '# entry point of the root\n')
  entry(join(work, 'README.md'), '# read me\n')
  for (const type of ['_tools_', '_verifiers_', '_monitors_', '_projects_']) {
    entry(join(work, type, 'INDEX.md'), `# ${type}\n`)
  }
  entry(join(work, '_tools_', 'some-tool', 'INDEX.md'), '# some-tool\n')
  entry(join(work, '_tools_', 'some-tool', 'run.py'), 'print("hi")\n')
  entry(join(work, '_verifiers_', '05-config-system', 'INDEX.md'), '# the claim\n')
  entry(join(work, '_verifiers_', '05-config-system', 'verify.sh'), 'exit 0\n')
  entry(join(work, '_projects_', 'a-project', 'INDEX.md'), '# a-project\n')
  entry(join(work, '_projects_', 'a-project', 'ULTIMATE_GOAL.md'), '# the goal\n')
  entry(join(work, '_projects_', 'a-project', '_context_', 'INDEX.md'), '# gathered\n')
  entry(join(work, '_projects_', 'a-project', '_context_', 'source-material', 'INDEX.md'), '# the material\n')
  entry(join(work, 'shared', 'INDEX.md'), '# shared\n')
  entry(join(work, 'shared', '_skills_', 'INDEX.md'), '# _skills_\n')
  entry(join(work, 'shared', '_skills_', 'a-skill', 'INDEX.md'), '# a-skill\n')
  entry(join(work, 'shared', '_skills_', 'a-skill', 'SKILL.md'), '# the skill\n')
  entry(join(work, 'dist', 'index.html'), '<!doctype html>\n')
  entry(join(work, 'node_modules', 'left-pad', 'package.json'), '{}\n')
  entry(join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  const added = await runCli(adminArgs(h, ['workspace', 'add', work]), { env: h.env, cwd: work })
  assert.equal(added.code, 0, `the fixture registered its own root\n${added.stdout}${added.stderr}`)
  return work
}

/** One level of the tree, read through the CLI. */
async function treeAt(h, path, options = {}) {
  const result = await runCli(adminArgs(h, ['tree', ...(path === undefined ? [] : [path]), '--json', ...(options.extra ?? [])]), {
    env: h.env,
    cwd: options.cwd ?? h.work,
  })
  return { result, tree: parseJson(result.stdout) }
}

/** The child a node names, or `undefined` when it does not list one. */
function childOf(node, label) {
  return (node?.children ?? []).find((entry) => entry.label === label)
}

/** The workspace listing, parsed. */
async function workspacesOf(h) {
  const result = await runCli(adminArgs(h, ['workspaces', '--json']), { env: h.env, cwd: h.work })
  assert.equal(result.code, 0, `the listing ran\n${result.stdout}${result.stderr}`)
  return parseJson(result.stdout)
}

/** The flat session listing, parsed. */
async function sessionsOf(h) {
  const result = await runCli(adminArgs(h, ['sessions', '--json']), { env: h.env, cwd: h.work })
  assert.equal(result.code, 0, `the listing ran\n${result.stdout}${result.stderr}`)
  return parseJson(result.stdout)
}

test('a run writes a session record that outlives it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('writes')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.timedOut, false, `the run finished\n${result.stdout}${result.stderr}`)
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const sessions = sessionsUnder(join(h.home, 'sessions'))
    assert.equal(sessions.length, 1, `the run left exactly one record behind\nfound: ${sessions.join(', ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the transcript is readable on disk and holds the turn', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('readable')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const transcript = transcriptFile(join(h.home, 'sessions', sessionsUnder(join(h.home, 'sessions'))[0] ?? ''))
    assert.ok(existsSync(transcript), `the transcript exists at ${transcript}`)

    const events = readTranscript(transcript)
    const kinds = [...new Set(events.map((event) => event.type))]
    for (const wanted of ['message', 'assistant/completed', 'turn/completed']) {
      assert.ok(kinds.includes(wanted), `the transcript records '${wanted}'\nsaw: ${kinds.join(', ')}`)
    }
    const recorded = events
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(recorded.includes('remember the word loom'), `the user's words are in the record\nsaw: ${recorded.join(' | ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a resumed session carries the earlier turns', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('resume')
  try {
    const first = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(id, 'the first run created a session')

    const second = await runCli([...h.args, '--turn', 'what did I ask you to remember', '--resume', id], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)

    const texts = readTranscript(join(h.home, 'sessions', id))
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(texts.includes('remember the word loom'), 'the first turn is still in the resumed session')
    assert.ok(texts.includes('what did I ask you to remember'), 'the second turn was appended to it')
    assert.equal(sessionsUnder(join(h.home, 'sessions')).length, 1, 'resuming did not start a second session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the record is appended to, never rewritten', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('append')
  try {
    await runCli([...h.args, '--turn', 'first'], { env: h.env })
    const id = sessionsUnder(join(h.home, 'sessions'))[0] ?? ''
    const transcript = transcriptFile(join(h.home, 'sessions', id))
    /**
     * Compared as **bytes**, because a transcript is now a sequence of zstd frames.
     *
     * Decoding it as UTF-8 and comparing strings would mostly work and occasionally fail: a frame
     * boundary can land in the middle of a multi-byte character, and the shorter read would end in a
     * replacement character where the longer one has the real one. The claim is about bytes anyway —
     * an append leaves everything before it untouched — so bytes are what is compared.
     */
    const before = readFileSync(transcript)
    await runCli([...h.args, '--turn', 'second', '--resume', id], { env: h.env })
    const after = readFileSync(transcript)
    assert.ok(after.length > before.length, 'the second turn was appended')
    assert.ok(after.subarray(0, before.length).equals(before), 'the earlier bytes are still the beginning of the file')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session is grouped under the workspace whose folder it ran in', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('grouped')
  try {
    const run = await runCli([...h.args, '--turn', 'say something'], { env: h.env, cwd: h.work })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)

    const listing = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), 'workspaces', '--json'], { env: h.env, cwd: h.work })
    assert.equal(listing.code, 0, `the command ran\n${listing.stdout}${listing.stderr}`)
    const workspaces = parseJson(listing.stdout)
    assert.ok(Array.isArray(workspaces) && workspaces.length > 0, `a workspace exists\n${listing.stdout}`)

    /**
     * The workspace is found by its **path**, not by its title, because a title is a label a person
     * can change and the path is what the association is actually made of.
     */
    const mine = workspaces.find((workspace) => workspace.path === h.work)
    assert.ok(mine, `the workspace names the directory the turn ran in (${h.work})\nsaw: ${workspaces.map((w) => w.path).join(', ')}`)
    assert.ok((mine.sessions ?? []).length > 0, 'and it holds the session that ran there')
    assert.equal(mine.sessions[0], sessionsUnder(join(h.home, 'sessions'))[0], 'the id in the record is the id on disk')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session in a subdirectory is a member of the workspace root above it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('subdir')
  const sub = join(h.work, 'nested', 'deeper')
  try {
    mkdirSync(sub, { recursive: true })
    const inParent = await runCli([...h.args, '--turn', 'from the parent'], { env: h.env, cwd: h.work })
    assert.equal(inParent.code, 0, `the parent turn ran\n${inParent.stdout}${inParent.stderr}`)
    const inChild = await runCli([...h.args, '--turn', 'from the child'], { env: h.env, cwd: sub })
    assert.equal(inChild.code, 0, `the child turn ran\n${inChild.stdout}${inChild.stderr}`)

    /**
     * This check asserted the **opposite** until 2026-10-11, and the reversal is the owner's.
     *
     * DSH's rule is equality — a session belongs to the workspace whose path is its working directory
     * exactly, so a subdirectory becomes a workspace of its own — and this check was written to pin
     * that, because it is the rule that surprises people. The owner then chose containment for
     * heddle, because the left column is a tree of *folders* rather than of workspaces: every folder
     * that holds a conversation would otherwise become a registration. The check now asserts the new
     * rule rather than being deleted, so the reversal is visible in the checks as well as in
     * [`../../SESSION_TREE.md`](../../SESSION_TREE.md).
     */
    const workspaces = await workspacesOf(h)
    assert.deepEqual(
      workspaces.map((workspace) => workspace.path),
      [h.work],
      `only the root above both directories is a workspace\nsaw: ${workspaces.map((workspace) => workspace.path).join(', ')}`,
    )
    assert.equal((workspaces[0].sessions ?? []).length, 2, 'and it accounts for the session in the subdirectory as well as its own')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('asking one folder twice continues one session, and both turns are in it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('find')
  try {
    await runCli([...h.args, '--turn', 'the first conversation'], { env: h.env, cwd: h.work })
    await runCli([...h.args, '--turn', 'the second conversation'], { env: h.env, cwd: h.work })

    /**
     * This check assumed the opposite until 2026-10-11: two runs in one folder made two sessions,
     * and the point was that both could be found again without an id. Under the owner's
     * one-session-per-folder rule the second prompt **continues** the first, so the claim to judge is
     * that the folder has exactly one session and that it holds both turns — a person who asks twice
     * in one folder asked twice in one conversation, which is what "the folder is the session" means.
     */
    const sessions = await sessionsOf(h)
    assert.ok(Array.isArray(sessions), 'the session list is machine-readable')
    assert.equal(sessions.length, 1, `one folder holds one session\n${JSON.stringify(sessions).slice(0, 300)}`)
    assert.ok(
      String(sessions[0].title ?? '').includes('the first conversation'),
      'the session keeps the title it was started with, so a person recognises it',
    )
    assert.ok(typeof sessions[0].created === 'string' && sessions[0].created.length > 0, 'and when it was created')

    const texts = readTranscript(join(h.home, 'sessions', sessions[0].id))
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(texts.includes('the first conversation'), 'the first prompt is in the one session')
    assert.ok(texts.includes('the second conversation'), 'and so is the second')

    const workspaces = await workspacesOf(h)
    const mine = workspaces.find((workspace) => workspace.path === h.work)
    assert.equal((mine?.sessions ?? []).length, 1, 'and the workspace accounts for that one session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

/*
 * The checks below judge the folder-bound session tree, which is stated in `SESSION_TREE.md` and was
 * not built when they were written (2026-10-11). Each reports unjudged until it is.
 */

test('starting a new session in a folder moves the folder to it, and the old one stays readable', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('rotate')
  const folder = join(h.work, '_tools_', 'some-tool')
  try {
    await conventionsFixture(h)
    assert.equal((await runCli([...h.args, '--turn', 'the old conversation'], { env: h.env, cwd: folder })).code, 0, 'the first turn ran')
    const before = await sessionsOf(h)
    assert.equal(before.length, 1, 'the first prompt made one session')
    const firstId = before[0].id

    const fresh = await runCli([...h.args, '--turn', 'a fresh conversation', '--new'], { env: h.env, cwd: folder })
    assert.equal(fresh.code, 0, `--new ran\n${fresh.stdout}${fresh.stderr}`)
    const after = await sessionsOf(h)
    assert.equal(after.length, 2, 'the new session did not replace the old one on disk')
    const freshId = after.map((meta) => meta.id).find((id) => id !== firstId)
    assert.ok(freshId, 'and it has an id of its own')

    /**
     * The folder points at its **current** session, which is the whole of "one folder, one session":
     * the history stays in the store and in `heddle sessions`, and only the folder's pointer moves.
     */
    const { tree } = await treeAt(h, folder)
    assert.equal(tree.session?.id, freshId, 'the folder now points at the new session')

    assert.equal((await runCli([...h.args, '--turn', 'and on we go'], { env: h.env, cwd: folder })).code, 0, 'the next turn ran')
    const finalList = await sessionsOf(h)
    assert.equal(finalList.length, 2, 'a prompt after --new continues the new session rather than making a third')

    const transcript = await runCli(adminArgs(h, ['transcript', firstId]), { env: h.env, cwd: h.work })
    assert.equal(transcript.code, 0, `the old session is still readable\n${transcript.stdout}${transcript.stderr}`)
    assert.match(transcript.stdout, /the old conversation/, 'and it still holds its own turn')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a sibling folder whose path shares a prefix is not a member', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('prefix')
  /**
   * A path prefix is not a directory ancestry, and this is the pair that tells them apart:
   * `<root>` and `<root>-sibling` share every character of the root's path. Membership compared as
   * strings would put the sibling inside the root; compared by segment it cannot.
   */
  const sibling = `${h.work}-sibling`
  try {
    mkdirSync(sibling, { recursive: true })
    assert.equal((await runCli([...h.args, '--turn', 'from the root'], { env: h.env, cwd: h.work })).code, 0, 'the root turn ran')
    assert.equal((await runCli([...h.args, '--turn', 'from the sibling'], { env: h.env, cwd: sibling })).code, 0, 'the sibling turn ran')

    const workspaces = await workspacesOf(h)
    const root = workspaces.find((workspace) => workspace.path === h.work)
    const other = workspaces.find((workspace) => workspace.path === sibling)
    assert.ok(other, `the sibling is a workspace of its own\nsaw: ${workspaces.map((workspace) => workspace.path).join(', ')}`)
    assert.equal((root?.sessions ?? []).length, 1, 'the root accounts only for its own session')
    assert.equal(other.sessions.length, 1, 'and the sibling accounts only for its own')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(sibling)
  }
})

test('the nearest registered root owns a session when roots nest', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('nest')
  const inner = join(h.work, 'inner')
  const deep = join(inner, 'deep')
  try {
    mkdirSync(deep, { recursive: true })
    for (const path of [h.work, inner]) {
      const added = await runCli(adminArgs(h, ['workspace', 'add', path]), { env: h.env, cwd: h.work })
      assert.equal(added.code, 0, `registering ${path} worked\n${added.stdout}${added.stderr}`)
    }
    assert.equal((await runCli([...h.args, '--turn', 'from deep'], { env: h.env, cwd: deep })).code, 0, 'the deep turn ran')

    const workspaces = await workspacesOf(h)
    const outer = workspaces.find((workspace) => workspace.path === h.work)
    const nearer = workspaces.find((workspace) => workspace.path === inner)
    assert.equal((nearer?.sessions ?? []).length, 1, 'the nearest root owns the session')
    assert.equal((outer?.sessions ?? []).length, 0, 'and the outer root does not claim it as well')

    const { tree } = await treeAt(h, h.work)
    assert.equal(childOf(tree, 'inner')?.kind, 'workspace', 'the outer tree shows the inner root as a workspace node')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the tree lists one folder level at a time, and a file is not a node', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('levels')
  try {
    await conventionsFixture(h)
    const { result, tree } = await treeAt(h, h.work)
    assert.equal(result.code, 0, `the tree ran\n${result.stdout}${result.stderr}`)

    const labels = (tree.children ?? []).map((node) => node.label)
    assert.ok(labels.includes('_tools_') && labels.includes('shared'), `the level lists folders\nsaw: ${labels.join(', ')}`)
    assert.ok(!labels.includes('AGENTS.md') && !labels.includes('README.md'), 'a file is not a node')
    assert.ok(!labels.includes('some-tool'), 'a grandchild is not listed, because its parent was not asked for')
    const tools = childOf(tree, '_tools_')
    assert.ok(tools, 'the type folder is there')
    assert.equal(tools.children, null, 'a node that was not expanded says so rather than reporting an empty list')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a type folder is a type, and its badge names it without the underscores', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('type')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, h.work)
    for (const [label, badge] of [
      ['_tools_', 'TLS'],
      ['_verifiers_', 'VRF'],
      ['_monitors_', 'MNT'],
    ]) {
      const node = childOf(tree, label)
      assert.equal(node?.kind, 'type', `${label} is a type folder`)
      assert.equal(node?.badge, badge, `${label} is badged from its own name`)
      assert.equal(node?.label, label, 'and it keeps the folder name as its label')
    }
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('an instance inside a type is an instance and keeps the folder name', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('instance')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, join(h.work, '_tools_'))
    const node = childOf(tree, 'some-tool')
    assert.ok(node, `the instance is listed\nsaw: ${(tree.children ?? []).map((child) => child.label).join(', ')}`)
    assert.equal(node.kind, 'instance', 'a kebab-case folder inside a type folder is an instance')
    assert.equal(node.label, 'some-tool', 'and its label is the folder name')
    assert.ok(node.badge === null || node.badge === undefined, 'an instance carries no type badge of its own')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a type inside an instance is a type again', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('recursive-type')
  try {
    await conventionsFixture(h)
    const project = join(h.work, '_projects_', 'a-project')
    const { tree } = await treeAt(h, project)
    const context_ = childOf(tree, '_context_')
    assert.equal(context_?.kind, 'type', 'a type folder inside an instance is a type')
    assert.equal(context_?.badge, 'CNT', 'badged from its own name, which keeps it apart from _conventions_')

    const deeper = await treeAt(h, join(project, '_context_'))
    assert.equal(childOf(deeper.tree, 'source-material')?.kind, 'instance', 'and its own instance is an instance, four levels down')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a plain container folder is a folder, and a type inside it is still a type', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('container')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, h.work)
    const shared = childOf(tree, 'shared')
    assert.equal(shared?.kind, 'folder', 'a plain-named folder is neither a type nor an instance')
    const inner = await treeAt(h, join(h.work, 'shared'))
    assert.equal(childOf(inner.tree, '_skills_')?.kind, 'type', 'and a type inside it is still a type')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('plumbing is hidden and a declared generated folder is named as one', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('hidden')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, h.work)
    const labels = (tree.children ?? []).map((node) => node.label)
    assert.ok(!labels.includes('.git'), 'a dot-directory is plumbing, not content')
    assert.ok(!labels.includes('node_modules'), 'and neither are installed dependencies')

    /**
     * A generated folder is invisible on disk, which is why the caller names it — the same word the
     * conventions linter takes (`--generated dist`), so one vocabulary decides it in both tools.
     *
     * Two directions are judged with two names, and the second name is the reason: `dist` is declared
     * by **heddle's own profile** (`heddle.patch.yml`, `generated: [dist]`), and this check runs that
     * profile — so `dist` must come back generated without any flag. Measured the hard way: the check
     * first asserted that undeclared `dist` is an ordinary folder, which stopped being true the moment
     * the project declared its own build output, and the failure was the check being wrong rather than
     * the tree.
     */
    assert.equal(childOf(tree, 'dist')?.kind, 'generated', 'the project profile declares dist, so the tree names it')

    entry(join(h.work, 'build', 'INDEX.md'), '# a folder nothing declares\n')
    const undeclared = await treeAt(h, h.work)
    assert.equal(childOf(undeclared.tree, 'build')?.kind, 'folder', 'an undeclared folder is an ordinary folder rather than hidden')

    const declared = await treeAt(h, h.work, { extra: ['--generated', 'build'] })
    assert.equal(childOf(declared.tree, 'build')?.kind, 'generated', 'and naming it marks it')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('only an instance carries a session, and nested plain folders do not', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('boundary')
  try {
    await conventionsFixture(h)
    const instance = join(h.work, '_tools_', 'some-tool')
    const deep = join(instance, 'src', 'deep')
    mkdirSync(deep, { recursive: true })

    /**
     * The owner's rule of 2026-10-11, and the fixture is built to break the obvious wrong version of
     * it: **a `_type_` folder is the boundary, and a session node exists only for an instance of
     * one.** A tree that showed a session on every folder holding one would put a session on the
     * workspace root, on `shared` and on `_tools_` itself — and on this deep plain folder, which is
     * the case the rule is really about: several levels of ordinary structure may sit inside an
     * instance, and none of them is a place to work.
     */
    for (const folder of [h.work, join(h.work, 'shared'), instance, deep]) {
      const label = folder === h.work ? 'the root' : folder.slice(h.work.length + 1)
      const run = await runCli([...h.args, '--turn', `from ${label}`], { env: h.env, cwd: folder })
      assert.equal(run.code, 0, `the turn in ${folder} ran\n${run.stdout}${run.stderr}`)
    }
    const stored = await sessionsOf(h)
    assert.equal(stored.length, 4, `four folders hold four sessions\n${JSON.stringify(stored.map((meta) => meta.cwd))}`)

    const { tree } = await treeAt(h, h.work)
    assert.equal(tree.session, null, 'the workspace root is a boundary, not an instance, so it carries no session')
    assert.equal(childOf(tree, 'shared')?.session, null, 'a plain container folder carries none either')

    const tools = await treeAt(h, join(h.work, '_tools_'))
    assert.equal(tools.tree.session, null, 'a type folder is the boundary itself, so it carries no session')
    const tool = childOf(tools.tree, 'some-tool')
    assert.ok(tool, 'the instance is listed under its type')
    assert.equal(tool.session?.turns, 1, 'and the instance carries the session that ran in it')

    const inside = await treeAt(h, instance)
    assert.equal(childOf(inside.tree, 'src')?.session, null, 'a plain folder inside an instance carries no session')
    const src = await treeAt(h, join(instance, 'src'))
    assert.equal(childOf(src.tree, 'deep')?.session, null, 'and neither does a folder nested two levels inside it')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the folder name is the session name, not the first prompt', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('label')
  const folder = join(h.work, '_tools_', 'some-tool')
  try {
    await conventionsFixture(h)
    assert.equal((await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env, cwd: folder })).code, 0, 'the turn ran')

    const { tree } = await treeAt(h, join(h.work, '_tools_'))
    const node = childOf(tree, 'some-tool')
    assert.equal(node?.label, 'some-tool', 'the node is named by its folder')
    assert.ok(typeof node?.session?.id === 'string', 'and it carries the folder session')

    const sessions = await sessionsOf(h)
    assert.match(String(sessions[0]?.title ?? ''), /remember the word loom/, 'while the transcript title is still the first prompt')
    assert.notEqual(node.label, sessions[0].title, 'the two are different facts and neither replaces the other')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('an empty type folder is a type with no children rather than an error', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('empty-type')
  try {
    await conventionsFixture(h)
    const { result, tree } = await treeAt(h, join(h.work, '_monitors_'))
    assert.equal(result.code, 0, `an empty type folder is not an error\n${result.stdout}${result.stderr}`)
    assert.equal(tree.kind, 'type', 'it is still a type folder')
    assert.deepEqual(tree.children, [], 'asked and empty is an empty list, which is not the same as unasked')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a folder outside every root is refused rather than walked', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('outside')
  const outside = fixtureDir('outside-root')
  try {
    entry(join(outside, 'INDEX.md'), '# not under any root\n')
    assert.equal((await runCli([...h.args, '--turn', 'from the root'], { env: h.env, cwd: h.work })).code, 0, 'the root turn ran')

    const { result } = await treeAt(h, outside)
    assert.notEqual(result.code, 0, 'a path that belongs to no root is refused')
    assert.match(`${result.stdout}${result.stderr}`, /root/i, 'and the refusal names the rule')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(outside)
  }
})

test('a session interrupted mid-frame still reads, and its next turn lands', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  /**
   * The failure this judges was found by testing the storage format rather than the feature: a
   * transcript torn in the middle of a frame made **every event written afterwards unreadable**,
   * because the reader walks frames and stops at the first incomplete one. A session interrupted
   * once therefore swallowed every later turn — written to the file, never read back.
   *
   * The check is end-to-end because that is where the claim lives: a person resumes an interrupted
   * session and expects their next turn to be there.
   */
  const h = harness('torn')
  try {
    const first = await runCli([...h.args, '--turn', 'before the interruption'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0] ?? ''
    const transcript = transcriptFile(join(h.home, 'sessions', id))

    // A crash that stopped writing partway through the newest frame.
    const whole = readFileSync(transcript)
    truncateSync(transcript, whole.length - 5)
    assert.ok(decodeTranscript(readFileSync(transcript)).torn, 'the fixture is genuinely torn')

    const second = await runCli([...h.args, '--resume', id, '--turn', 'after the interruption'], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)

    const events = readTranscript(join(h.home, 'sessions', id))
    const said = events
      .filter((event) => event.type === 'message' && event.message?.role === 'user')
      .map((event) => event.message.content?.[0]?.text)
    assert.ok(said.includes('before the interruption'), `the earlier turn survived the tear\nsaw: ${said.join(' | ')}`)
    assert.ok(said.includes('after the interruption'), `and the turn written after it is readable\nsaw: ${said.join(' | ')}`)
    assert.ok(
      events.some((event) => event.type === 'transcript/repaired'),
      'and the session says it was repaired rather than pretending nothing happened',
    )
    assert.ok(!decodeTranscript(readFileSync(transcript)).torn, 'the record no longer ends in a half-written frame')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})
