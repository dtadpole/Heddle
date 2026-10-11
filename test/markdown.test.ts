import assert from 'node:assert/strict'
import { test } from 'node:test'

import { escapeHtml, renderMarkdown } from '../src/server/markdown.ts'

/**
 * Unit tests for the document renderer.
 *
 * The property that matters most is the first one: a document is **untrusted text** — it comes from a model, a
 * repository, or a person — and the only tags in the output may be the ones the renderer writes. A renderer
 * that gets that wrong fails silently and dangerously, so it is asserted rather than assumed.
 */

test('a document cannot inject markup', () => {
  const html = renderMarkdown('Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>')
  assert.ok(!html.includes('<script'), 'no script tag survives')
  assert.ok(!html.includes('<img src=x'), 'and no attribute can be smuggled in through a tag')
  assert.match(html, /&lt;script&gt;/, 'the text is shown as text')
})

test('a link that would run script is refused, and the label survives', () => {
  /**
   * The first version of this test asserted only that the URL stayed inside its attribute, and rationalised
   * `javascript:` as "the browser decides". That is not a guarantee: the browser follows what it is given, and
   * a document is untrusted text. The renderer now checks the scheme, so the link becomes text and the reader
   * still sees the words.
   */
  const html = renderMarkdown('[click](javascript:alert(1))')
  assert.ok(!html.includes('<a '), 'no anchor is produced at all')
  assert.match(html, /click \(link refused\)/, 'and the label is shown with the reason')
  assert.ok(!html.includes('\" onclick'), 'nothing can add an attribute of its own')

  /** A `data:` URL is the same hazard in a different spelling. */
  assert.ok(!renderMarkdown('[x](data:text/html,<script>alert(1)</script>)').includes('<a '), 'a data URL is refused too')

  for (const url of ['https://example.com/a', 'http://example.com', 'mailto:someone@example.com', 'docs/INDEX.md', '#a-heading']) {
    assert.ok(renderMarkdown(`[label](${url})`).includes('<a href='), `${url} is followed`)
  }
})

test('headings, paragraphs, and rules', () => {
  const html = renderMarkdown('# Title\n\nA paragraph.\n\n---\n\n## Second\n')
  assert.match(html, /<h1>Title<\/h1>/, 'a level-one heading')
  assert.match(html, /<p>A paragraph\.<\/p>/, 'a paragraph')
  assert.match(html, /<hr>/, 'a rule')
  assert.match(html, /<h2>Second<\/h2>/, 'a level-two heading')
})

test('emphasis, code spans, and strikethrough', () => {
  const html = renderMarkdown('Use **bold**, *italic*, `code`, and ~~gone~~.')
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<em>italic<\/em>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<del>gone<\/del>/)
})

test('emphasis inside a code span stays literal, because a document about code depends on it', () => {
  const html = renderMarkdown('The literal `a ** b` is multiplication.')
  assert.match(html, /<code>a \*\* b<\/code>/, 'the asterisks survive as text')
  assert.ok(!html.includes('<strong>'), 'and nothing is bolded inside it')
})

test('a fenced block keeps its language and its text exactly', () => {
  const html = renderMarkdown('```ts\nconst x: number = 1 < 2 ? a : b\n```')
  assert.match(html, /<pre><code class="language-ts">/, 'the language is carried')
  assert.match(html, /const x: number = 1 &lt; 2 \? a : b/, 'the code is escaped and otherwise untouched')
})

test('an unterminated fence still renders its content rather than swallowing it', () => {
  const html = renderMarkdown('```\nno closing fence\n')
  assert.match(html, /no closing fence/, 'the lines are shown')
  assert.match(html, /<pre><code>/, 'inside a code block')
})

test('consecutive items join one list, and a switch of marker starts another', () => {
  const html = renderMarkdown('- one\n- two\n\n1. first\n2. second\n')
  assert.equal((html.match(/<ul>/g) ?? []).length, 1, 'one unordered list')
  assert.equal((html.match(/<ol>/g) ?? []).length, 1, 'and one ordered list')
  assert.equal((html.match(/<li>/g) ?? []).length, 4, 'holding every item')
})

test('a quote is its own block', () => {
  const html = renderMarkdown('> quoted words\n> on two lines\n')
  assert.match(html, /<blockquote>quoted words on two lines<\/blockquote>/, 'the lines join, as a paragraph does')
})

test('an unrecognised construct is shown rather than dropped', () => {
  /**
   * A renderer that swallows what it does not understand loses the reader's text without saying so, which is
   * worse than showing it plainly.
   */
  const html = renderMarkdown('| a | b |\n| - | - |\n\n::: callout\nodd\n:::')
  assert.match(html, /\| a \| b \|/, 'a table becomes its own text')
  assert.match(html, /::: callout/, 'and an unknown directive is still visible')
})

test('text is escaped before the inline rules run, so markup cannot be manufactured', () => {
  const html = renderMarkdown('**<b>not bold</b>**')
  assert.match(html, /<strong>&lt;b&gt;not bold&lt;\/b&gt;<\/strong>/, 'the escaping holds inside emphasis')
})

test('escaping covers every character that can break out', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
})

test('rendering is repeatable and empty input is empty output', () => {
  const source = '# A\n\ntext with `code`\n'
  assert.equal(renderMarkdown(source), renderMarkdown(source), 'no state to drift')
  assert.equal(renderMarkdown(''), '', 'and nothing in gives nothing out')
})

test('a document\'s frontmatter is shown as metadata, not read as prose', () => {
  /**
   * Every document in this repository opens with a YAML block. Measured: it rendered as the first paragraph —
   * `title: heddle version: 0.3.0 description: …` — which reads as a sentence and is not one.
   */
  const html = renderMarkdown('---\ntitle: A Document\nversion: 1.0.0\n---\n\n# Heading\n\nBody.\n')
  assert.match(html, /<section class="frontmatter">/, 'the block is lifted into its own section')
  assert.match(html, /title: A Document/, 'with its content intact')
  assert.doesNotMatch(html, /<p>title:/, 'and it is not rendered as a paragraph')
  assert.match(html, /<h1>Heading<\/h1>/, 'while the body renders normally')

  /** A document without frontmatter is unchanged by the rule. */
  assert.doesNotMatch(renderMarkdown('# Plain\n'), /frontmatter/)
  /** And a `---` that is a thematic break rather than an opening fence is still a rule. */
  assert.match(renderMarkdown('text\n\n---\n\nmore'), /<hr>/, 'a rule later in the document is still a rule')
})
