import highlightJs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * Syntax highlighting for fenced code, on **highlight.js**.
 *
 * Chosen the same way the markdown renderer was, by measurement rather than preference:
 *
 * - `highlight.js` 11.12.0 has **zero dependencies**;
 * - `prismjs` 1.30.0 also has zero, but needs a component per language and a CSS file per theme, and its Node
 *   usage is a global singleton rather than a function;
 * - `shiki` 4.5.0 is the best-looking of the three and pulls **8 packages** with TextMate grammars and themes —
 *   a large cost for colouring code in a local document view.
 *
 * The full `highlight.js` package is 9.2 MB because it ships every language. This imports `core` — no grammar — and
 * registers **only the languages below**, which keeps the cost proportional to what is used.
 *
 * `lowlight`, the wrapper the plugin is usually paired with, was measured and **rejected**: it adds three packages
 * including `highlight.js` itself, for an interface this file is four lines of. The library is used directly.
 *
 * The set is what this repository and its sessions actually contain: the languages of the harness and its
 * documents, plus a few a tool output can be in. A fence whose language is not registered, or has none, is still
 * rendered — as plain text, with the class the highlighter gives it — so nothing is lost by the choice.
 */

/** The registered grammars, and the spellings a fence is likely to use for each. */
const GRAMMARS = {
  bash, c, cpp, css, diff, go, ini, java, javascript, json, markdown, php, plaintext, python, ruby, rust, sql,
  typescript, xml, yaml,
} as const

const ALIASES: Readonly<Record<string, keyof typeof GRAMMARS>> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  yml: 'yaml',
  jsonc: 'json', json5: 'json',
  html: 'xml', svg: 'xml', xhtml: 'xml',
  md: 'markdown', mdown: 'markdown',
  rs: 'rust', golang: 'go', 'c++': 'cpp', h: 'c', hpp: 'cpp',
  rb: 'ruby', cfg: 'ini', conf: 'ini', text: 'plaintext', txt: 'plaintext', plain: 'plaintext',
  /** `highlight.js` ships no TOML grammar, and an INI grammar colours the same key/value shape. */
  toml: 'ini', properties: 'ini', env: 'ini',
}

const hljs = highlightJs

/** Register the chosen grammars once, on first use. */
let registered = false
function ready(): void {
  if (registered) return
  registered = true
  for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar)
}

/**
 * Highlight a code block.
 *
 * Returns the HTML for the **inside** of a `<pre><code>`: the library's spans, which the allow-list in
 * `sanitize.ts` accepts because `span` and `class` are on it and nothing else is.
 */
export function highlightCode(code: string, language?: string): string {
  ready()
  const requested = String(language ?? '').toLowerCase().trim()
  const name = (ALIASES[requested] ?? requested) as keyof typeof GRAMMARS
  if (name === undefined || !(name in GRAMMARS)) {
    /** No language, or one not registered: the text is still returned, escaped by the highlighter itself. */
    return hljs.highlight(code, { language: 'plaintext' }).value
  }
  try {
    return hljs.highlight(code, { language: name }).value
  } catch {
    /** A grammar that refuses its input is a rendering concern, not a reason to lose the block. */
    return hljs.highlight(code, { language: 'plaintext' }).value
  }
}

/** Whether a fence's language is one this build can colour. */
export function supportsLanguage(language: string): boolean {
  const requested = String(language ?? '').toLowerCase().trim()
  const name = ALIASES[requested] ?? requested
  return name !== undefined && name in GRAMMARS
}
