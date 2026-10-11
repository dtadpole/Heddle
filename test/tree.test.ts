import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isUnder } from '../src/paths.ts'
import { badgeFor, classify, kindOf, tree, type TreeInput } from '../src/session/tree.ts'
import type { SessionMeta } from '../src/session/store.ts'

/**
 * The tree's primitives, pinned without a store, a CLI or a filesystem walk.
 *
 * The verifier judges the same rules from a user's seat, over the built CLI and a fixture that looks
 * like the conventions repository. These tests are the cheaper half: the badge rule, the
 * classification and the segment comparison are each one line of behaviour whose *edges* are what
 * bite, and an edge found here costs a second rather than a fixture.
 */

function scaffold(layout: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'heddle-tree-'))
  for (const path of layout) mkdirSync(join(root, path), { recursive: true })
  return root
}

function session(id: string, cwd: string, created: string, turns = 1): SessionMeta {
  return { id, cwd, created, turns }
}

test('a type badge drops the vowels, which is what keeps the three con types apart', () => {
  assert.equal(badgeFor('_verifiers_'), 'VRF')
  assert.equal(badgeFor('_tools_'), 'TLS')
  assert.equal(badgeFor('_context_'), 'CNT')
  assert.equal(badgeFor('_conventions_'), 'CNV')
  assert.equal(badgeFor('_constitutions_'), 'CNS')
  // Fewer than three consonants left: the full name supplies the rest rather than a short badge.
  assert.equal(badgeFor('_web_'), 'WEB')
  assert.equal(badgeFor('_data_'), 'DAT')
})

test('a folder is classified against its parent, not by its own name alone', () => {
  const none = new Set<string>()
  assert.equal(classify('_tools_', 'workspace', none), 'type')
  assert.equal(classify('_context_', 'workspace', none), 'type')
  assert.equal(classify('source-material', 'type', none), 'instance')
  // The same name is not an instance when nothing above it is a type.
  assert.equal(classify('source-material', 'workspace', none), 'folder')
  // Two to four words: one word is not an instance name, which is a real rule and not a detail.
  assert.equal(classify('material', 'type', none), 'folder')
  assert.equal(classify('shared', 'workspace', none), 'folder')
  assert.equal(classify('dist', 'workspace', new Set(['dist'])), 'generated')
})

test('containment is compared by path segment, never by string', () => {
  assert.equal(isUnder('/a/b', '/a/b'), true, 'a folder is under itself')
  assert.equal(isUnder('/a/b', '/a/b/c'), true)
  assert.equal(isUnder('/a/b', '/a/b-sibling'), false, 'the trap: every character matches, the segment does not')
  assert.equal(isUnder('/a/b', '/a'), false)
  assert.equal(isUnder('/', '/anything'), true)
})

test('the tree shows a session on an instance and on nothing else', () => {
  const root = scaffold([
    '_tools_/some-tool',
    '_tools_/some-tool/src/deep',
    'shared',
    '_monitors_',
  ])
  const input: TreeInput = {
    roots: [{ path: root, title: 'fixture' }],
    sessions: [
      session('s-root', root, '2026-10-11T10:00:00.000Z'),
      session('s-tool', join(root, '_tools_', 'some-tool'), '2026-10-11T10:01:00.000Z'),
      session('s-deep', join(root, '_tools_', 'some-tool', 'src', 'deep'), '2026-10-11T10:02:00.000Z'),
      session('s-shared', join(root, 'shared'), '2026-10-11T10:03:00.000Z'),
    ],
    generated: ['dist'],
  }
  try {
    const atRoot = tree(root, input)
    assert.equal(atRoot.kind, 'workspace')
    assert.equal(atRoot.session, null, 'the root is a boundary rather than an instance')

    const tools = (atRoot.children ?? []).find((node) => node.label === '_tools_')
    assert.equal(tools?.kind, 'type')
    assert.equal(tools?.session, null, 'a type folder is the boundary itself')
    assert.equal(tools?.children, null, 'and it was not expanded, which is not the same as empty')

    const instance = tree(join(root, '_tools_'), input).children?.find((node) => node.label === 'some-tool')
    assert.equal(instance?.kind, 'instance')
    assert.equal(instance?.session?.id, 's-tool', 'the instance carries the session that ran in it')

    const inside = tree(join(root, '_tools_', 'some-tool'), input)
    assert.equal(inside.children?.find((node) => node.label === 'src')?.session, null, 'a plain folder inside carries none')

    const shared = (atRoot.children ?? []).find((node) => node.label === 'shared')
    assert.equal(shared?.kind, 'folder')
    assert.equal(shared?.session, null, 'and a plain container carries none either')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the newest session bound to an instance is the one the instance shows', () => {
  const root = scaffold(['_tools_/some-tool'])
  const folder = join(root, '_tools_', 'some-tool')
  try {
    const input: TreeInput = {
      roots: [{ path: root, title: 'fixture' }],
      // Deliberately not in order: the newest is what the folder points at, whatever the list order.
      sessions: [
        session('s-old', folder, '2026-10-11T09:00:00.000Z'),
        session('s-new', folder, '2026-10-11T11:00:00.000Z'),
        session('s-middle', folder, '2026-10-11T10:00:00.000Z'),
      ],
    }
    const node = tree(join(root, '_tools_'), input).children?.find((child) => child.label === 'some-tool')
    assert.equal(node?.session?.id, 's-new')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a nested root is a workspace node inside its parent, and owns what is under it', () => {
  const root = scaffold(['inner/deep'])
  const inner = join(root, 'inner')
  try {
    const input: TreeInput = {
      roots: [
        { path: root, title: 'outer' },
        { path: inner, title: 'inner' },
      ],
      sessions: [session('s-deep', join(inner, 'deep'), '2026-10-11T10:00:00.000Z')],
    }
    const outer = tree(root, input)
    const nested = (outer.children ?? []).find((node) => node.label === 'inner')
    assert.equal(nested?.kind, 'workspace', 'a registered root is a workspace node rather than a folder')

    const roots = tree(null, input)
    assert.equal(roots.kind, 'roots')
    assert.deepEqual(
      (roots.children ?? []).map((node) => node.label),
      ['outer'],
      'the nested root is not also listed at the top level',
    )

    // The instance rule still applies under the nested root: `deep` is plain, so its session is stored
    // and accounted for but is not a node.
    const atInner = tree(inner, input)
    assert.equal(atInner.children?.find((node) => node.label === 'deep')?.session, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kindOf walks from the root, so a type may repeat at any depth', () => {
  const root = scaffold(['_projects_/a-project/_context_/source-material'])
  try {
    const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions: [] }
    assert.equal(kindOf(join(root, '_projects_'), input), 'type')
    assert.equal(kindOf(join(root, '_projects_', 'a-project'), input), 'instance')
    assert.equal(kindOf(join(root, '_projects_', 'a-project', '_context_'), input), 'type')
    assert.equal(kindOf(join(root, '_projects_', 'a-project', '_context_', 'source-material'), input), 'instance')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plumbing is not enumerated and a declared generated folder is named as one', () => {
  const root = scaffold(['node_modules/left-pad', '.git/objects', 'dist', '_logs_/repo-actions'])
  try {
    const input: TreeInput = {
      roots: [{ path: root, title: 'fixture' }],
      sessions: [],
      generated: ['dist'],
    }
    const labels = (tree(root, input).children ?? []).map((node) => node.label)
    assert.deepEqual(labels, ['_logs_', 'dist'], `plumbing is absent and the rest is name-sorted\nsaw: ${labels.join(', ')}`)
    const dist = (tree(root, input).children ?? []).find((node) => node.label === 'dist')
    assert.equal(dist?.kind, 'generated')
    assert.equal(dist?.badge, null, 'and it is not a type, so it has no badge')
    assert.equal(dist?.children, null, 'a child that was not expanded reports no children rather than an empty list')
    assert.deepEqual(tree(join(root, 'dist'), input).children, [], 'asked for, an empty folder reports an empty list')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file is never a node, and an unreadable folder is empty rather than fatal', () => {
  const root = scaffold(['_tools_/some-tool'])
  try {
    writeFileSync(join(root, 'README.md'), '# read me\n')
    writeFileSync(join(root, '_tools_', 'INDEX.md'), '# the type\n')
    const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions: [] }
    assert.deepEqual((tree(root, input).children ?? []).map((node) => node.label), ['_tools_'])
    const missing = tree(join(root, 'not-there'), input)
    assert.deepEqual(missing.children, [], 'a folder that does not exist has nothing to show')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
