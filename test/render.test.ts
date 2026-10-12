import assert from 'node:assert/strict'
import { test } from 'node:test'

import { languageFor, renderCode, renderSource, rendererFor } from '../src/server/code.ts'

/**
 * The code renderer: what the file panel shows for source, and the one property that matters most.
 *
 * That property is **nothing is lost and nothing is invented**. Highlighting is cosmetic, but the text
 * is a file somebody else wrote, so the suite asserts it by stripping the tags back off the rendered
 * markup and comparing with the source — a renderer that swallowed a construct, or that let a byte of
 * the file become markup, fails here rather than in a reader's understanding.
 */

/** Undo the escaping, so markup can be compared with the text it came from. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The source back out of the markup: drop the gutter, drop the tags, undo the escaping. */
function textOf(html: string): string {
  return unescapeHtml(html.replace(/<span class="ln">\d*<\/span>/g, '').replace(/<[^>]+>/g, ''))
}

test('the rendered markup gives the source back, exactly', () => {
  const samples = [
    'const answer = 42\n',
    'def f(x):\n    # a comment\n    return x + 1\n',
    'no trailing newline',
    '',
    '\n\n\n',
    'const s = "a < b && c > d"\nconst t = `back ${s}`\n',
    'x = """a docstring\nwith a newline"""\n',
    'if (a /* inline */ && b) {\n  // tail\n}\n',
    '#!/usr/bin/env bash\nset -euo pipefail\necho "hi"\n',
  ]
  for (const language of ['javascript', 'typescript', 'python', 'json', 'shell']) {
    for (const source of samples) {
      assert.equal(textOf(renderCode(source, language)), source, `${language}: ${JSON.stringify(source)}`)
    }
  }
})

test('a file full of markup arrives as text and never as markup', () => {
  const hostile = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n</code></span>'
  const html = renderCode(hostile, 'javascript')
  assert.ok(!html.includes('<script'), 'no script tag survives')
  assert.ok(!html.includes('<img'), 'nor an image with a handler')
  assert.ok(!html.includes('onerror=') || html.includes('onerror=alert(2)') === false, 'nor an attribute')
  assert.ok(html.includes('&lt;script&gt;'), 'the text is visible, escaped')
  assert.equal(textOf(html), hostile, 'and it is still the file')
})

test("the classes are the highlighter's, and they say what was recognised", () => {
  /**
   * The classes are `highlight.js`'s own (`hljs-*`), because the classification is now the library's rather than
   * this project's. That is the point of the change: one highlighter for a fenced block inside a document and for a
   * whole source file, so the two cannot disagree about what a keyword is.
   */
  const html = renderCode('// a comment\nconst x = 12 // tail\n', 'javascript')
  assert.match(html, /<span class="hljs-comment">\/\/ a comment<\/span>/)
  assert.match(html, /<span class="hljs-keyword">const<\/span>/)
  assert.match(html, /<span class="hljs-number">12<\/span>/)
  assert.ok(!html.includes('>x</span>'), 'an identifier is not a keyword')

  const python = renderCode('def f():\n    return None  # done\n', 'python')
  assert.match(python, /<span class="hljs-keyword">def<\/span>/)
  assert.match(python, /<span class="hljs-comment"># done<\/span>/)
  assert.ok(!python.includes('hljs-comment"># done\n'), 'the comment stops at the line, not at the file')
})

test('the gutter numbers every line and starts at one', () => {
  const html = renderCode('a\nb\nc\n', 'javascript')
  const numbers = [...html.matchAll(/<span class="ln">(\d+)<\/span>/g)].map((match) => match[1])
  assert.deepEqual(numbers, ['1', '2', '3', '4'], 'three lines and the empty one a trailing newline makes')
})

test('a language is chosen by extension, and an unknown one is shown as text', () => {
  assert.equal(languageFor('/x/app.js'), 'javascript')
  assert.equal(languageFor('/x/app.mjs'), 'javascript')
  assert.equal(languageFor('/x/app.tsx'), 'typescript')
  assert.equal(languageFor('/x/tool.py'), 'python')
  assert.equal(languageFor('/x/UPPER.PY'), 'python', 'case is not the filename’s business')
  assert.equal(languageFor('/x/notes.txt'), undefined)

  /**
   * The shapes a repository is actually written in, all of which the highlighter has grammars for.
   *
   * Measured: `cordis.yml` rendered as plain text, so the one file that says how the harness is configured was a
   * wall of text while `package.json` beside it was coloured.
   */
  for (const [path, language] of [
    ['/x/cordis.yml', 'yaml'],
    ['/x/state.yaml', 'yaml'],
    ['/x/Cargo.toml', 'ini'],
    ['/x/style.css', 'css'],
    ['/x/index.html', 'xml'],
    ['/x/fix.patch', 'diff'],
  ] as const) {
    assert.equal(languageFor(path), language, `${path} is recognised`)
  }

  assert.deepEqual(rendererFor('/x/README.md'), { renderer: 'markdown' })
  assert.deepEqual(rendererFor('/x/tool.py'), { renderer: 'code', language: 'python' })
  assert.deepEqual(rendererFor('/x/notes.txt'), { renderer: 'text' })
})

test('renderSource decides, and a document renders as a document', () => {
  const markdown = renderSource('/x/README.md', '# Title\n\n- one\n- two\n')
  assert.equal(markdown.renderer, 'markdown')
  assert.match(markdown.html ?? '', /<h1>Title<\/h1>/)
  assert.match(markdown.html ?? '', /<li>one<\/li>/)

  const code = renderSource('/x/tool.py', 'print("hi")\n')
  assert.equal(code.renderer, 'code')
  assert.equal(code.language, 'python')
  assert.match(code.html ?? '', /hljs-string/)

  const text = renderSource('/x/notes.txt', 'just text\n')
  assert.equal(text.renderer, 'text')
  assert.equal(text.html, undefined, 'plain text is shown verbatim, so no markup is produced for it')
})

test('a carriage return does not become a line', () => {
  const html = renderCode('a\r\nb\r\n', 'javascript')
  assert.equal(textOf(html), 'a\nb\n', 'CRLF is normalised, so the gutter and the file agree')
  assert.equal([...html.matchAll(/<span class="ln">/g)].length, 3)
})
