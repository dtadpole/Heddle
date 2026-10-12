import assert from 'node:assert/strict'
import { test } from 'node:test'

import { highlightCode, supportsLanguage } from '../src/server/highlight.ts'
import { renderMarkdown } from '../src/server/markdown.ts'

/**
 * Unit tests for code highlighting.
 *
 * The claim is narrow on purpose: a fence in a language this build registers is **coloured**, and one it does not
 * register is **still rendered**. Highlighting is a presentation of code that is already correct, so the failure
 * that matters is losing the block, not colouring it imperfectly.
 */

test('a registered language is coloured', () => {
  const json = highlightCode('{"a": 1}', 'json')
  assert.match(json, /hljs-/, 'the highlighter emits its own spans')
  assert.match(json, /hljs-attr|hljs-string/, 'with a class for what the text is')
})

test('every language this repository is written in is registered', () => {
  for (const language of ['typescript', 'javascript', 'python', 'json', 'yaml', 'bash', 'markdown', 'xml', 'css', 'diff', 'sql']) {
    assert.ok(supportsLanguage(language), `${language} is registered`)
  }
})

test('the spellings a fence actually uses resolve to the same grammar', () => {
  for (const alias of ['ts', 'js', 'tsx', 'py', 'yml', 'sh', 'shell', 'zsh', 'md', 'html', 'rb', 'rs', 'c++', 'toml']) {
    assert.ok(supportsLanguage(alias), `${alias} resolves to a grammar`)
  }
  assert.equal(highlightCode('const x = 1', 'ts'), highlightCode('const x = 1', 'typescript'), 'and to the same output')
})

test('a language that is not registered still renders its code', () => {
  /**
   * The failure worth guarding: a fence nobody registered must not vanish. `highlight.js` ships no brainfuck
   * grammar, so this is that case — the text comes back, escaped, with no colouring.
   */
  const html = highlightCode('+++[>+<]>', 'brainfuck')
  assert.match(html, /\+\+\+/, 'the code is there')
  assert.ok(!html.includes('hljs-keyword'), 'with no grammar applied')
})

test('code with no language at all is escaped rather than interpreted', () => {
  const html = highlightCode('<script>alert(1)</script>', '')
  assert.ok(!html.includes('<script>'), 'the tags are entities')
  assert.match(html, /&lt;script&gt;/, 'and the text is readable')
})

test('a fence is coloured in the rendered document, and its class survives the allow-list', () => {
  /**
   * The interaction that has to hold: the highlighter's spans are only visible if the sanitizer keeps `span` and
   * `class`, and loses nothing else. This is the end-to-end claim for the pair.
   */
  /** The snippet holds a keyword on purpose: `def f(x): return x` has none, so it coloured nothing to assert. */
  const html = renderMarkdown('```python\ndef f(x):\n    return x if x else None\n```')
  assert.match(html, /<pre><code class="language-python">/, 'the fence keeps its language')
  assert.match(html, /hljs-keyword/, "the highlighter's spans survive the allow-list")
  assert.ok(!html.includes('<span onclick'), 'and nothing the allow-list forbids gets through with them')
})

test('an unregistered fence is rendered as code, not dropped', () => {
  const html = renderMarkdown('```brainfuck\n+++\n```')
  assert.match(html, /<pre><code/, 'the block is there')
  assert.match(html, /\+\+\+/, 'with its text')
})

test('a fence with no language is rendered without inventing one', () => {
  const html = renderMarkdown('```\nplain <text>\n```')
  assert.match(html, /<pre><code>/, 'no language class is added')
  assert.match(html, /plain &lt;text&gt;/, 'and the text is escaped')
})
