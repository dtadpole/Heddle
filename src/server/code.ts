import { extname } from 'node:path'

import { escapeHtml, renderMarkdown } from './markdown.ts'

/**
 * The code renderer: a source file shown as source rather than as a wall of text.
 *
 * The whole design is one rule — **this file writes every tag, and every byte of the file is
 * escaped** — because the text being rendered is a file somebody else wrote. A file containing
 * `<script>alert(1)</script>` must arrive in the panel as six visible tokens, not as a script; that is
 * the same stance [`markdown.ts`](markdown.ts) takes, and it is why nothing here interpolates raw
 * input into markup.
 *
 * The scanner is deliberately small and **total**: it walks the text once, recognises comments,
 * strings, numbers and keywords, and emits everything else as escaped text. It never re-orders,
 * drops or invents a character, which is a property the unit suite asserts by stripping the tags back
 * off and comparing with the source. A renderer that quietly swallowed a construct would be worse than
 * no highlighting, because the reader would believe what they saw.
 *
 * No dependency, for the same reason the rest of this project has none: a highlighter is a luxury, and
 * a panel that cannot render a file because a package is missing is not a luxury worth having.
 */

/** What the file panel should do with a file. */
export type RendererName = 'markdown' | 'code' | 'text'

/** A decision about one file, and the markup when there is any. */
export interface Rendered {
  readonly renderer: RendererName
  readonly language?: string
  /** Present for `markdown` and `code`; absent for `text`, which the panel shows verbatim. */
  readonly html?: string
}

/** The languages this renderer knows, by extension. */
const LANGUAGES: Readonly<Record<string, string>> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.pyi': 'python',
  '.json': 'json',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
}

/** Words a language reserves, which are the only thing highlighting claims to know. */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  javascript: [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do',
    'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof',
    'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
    'while', 'yield', 'true', 'false', 'null', 'undefined',
  ],
  typescript: [
    'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const',
    'constructor', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
    'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
    'interface', 'is', 'keyof', 'let', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of',
    'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'static', 'string', 'super',
    'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var',
    'void', 'while', 'yield',
  ],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
    'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
    'or', 'pass', 'raise', 'return', 'self', 'try', 'while', 'with', 'yield', 'True', 'False', 'None',
  ],
  json: ['true', 'false', 'null'],
  shell: [
    'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'local', 'return',
    'then', 'until', 'while',
  ],
}

/** The language a path's extension names, or `undefined` when this renderer does not know it. */
export function languageFor(path: string): string | undefined {
  return LANGUAGES[extname(path).toLowerCase()]
}

/** What should be done with a file, before its text is read. */
export function rendererFor(path: string): { readonly renderer: RendererName; readonly language?: string } {
  const extension = extname(path).toLowerCase()
  if (extension === '.md' || extension === '.markdown') return { renderer: 'markdown' }
  const language = LANGUAGES[extension]
  return language === undefined ? { renderer: 'text' } : { renderer: 'code', language }
}

/** One span of source, classified. */
type Piece =
  | { readonly kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword'; readonly text: string }
  | { readonly kind: 'newline' }

/** Whether a character can start an identifier in the C-like and Python grammars alike. */
function isWordStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character)
}

function isWordPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character)
}

/**
 * Split source into classified pieces without losing a character.
 *
 * The scanner is line-blind: it reads comments, strings and numbers wherever they start, and the line
 * numbers are added by the printer. That keeps the two concerns apart, which matters because the line
 * count is also what the panel's header reports.
 */
function scan(source: string, language: string): readonly Piece[] {
  const pieces: Piece[] = []
  const keywords = new Set(KEYWORDS[language] ?? [])
  const lineComment = language === 'python' || language === 'shell' ? '#' : language === 'json' ? undefined : '//'
  const blockComment = language === 'python' || language === 'shell' || language === 'json' ? false : true
  const backtick = language === 'javascript' || language === 'typescript' || language === 'shell'

  let plain = ''
  const flush = (): void => {
    if (plain.length > 0) pieces.push({ kind: 'plain', text: plain })
    plain = ''
  }

  let index = 0
  while (index < source.length) {
    const character = source[index] ?? ''

    if (character === '\n') {
      flush()
      pieces.push({ kind: 'newline' })
      index += 1
      continue
    }

    if (lineComment !== undefined && source.startsWith(lineComment, index)) {
      const end = source.indexOf('\n', index)
      flush()
      pieces.push({ kind: 'comment', text: end === -1 ? source.slice(index) : source.slice(index, end) })
      index = end === -1 ? source.length : end
      continue
    }

    if (blockComment && source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      flush()
      pieces.push({ kind: 'comment', text: end === -1 ? source.slice(index) : source.slice(index, end + 2) })
      index = end === -1 ? source.length : end + 2
      continue
    }

    /**
     * Python's triple-quoted strings are read before the single ones, or `'''` would be three strings
     * and the docstring between them would be read as code.
     */
    if (language === 'python' && (source.startsWith("'''", index) || source.startsWith('"""', index))) {
      const fence = source.slice(index, index + 3)
      const end = source.indexOf(fence, index + 3)
      flush()
      pieces.push({ kind: 'string', text: end === -1 ? source.slice(index) : source.slice(index, end + 3) })
      index = end === -1 ? source.length : end + 3
      continue
    }

    if (character === '"' || character === "'" || (backtick && character === '`')) {
      let cursor = index + 1
      while (cursor < source.length) {
        const next = source[cursor] ?? ''
        if (next === '\\') {
          cursor += 2
          continue
        }
        if (next === character || next === '\n') break
        cursor += 1
      }
      const closed = source[cursor] === character
      const end = closed ? cursor + 1 : cursor
      flush()
      pieces.push({ kind: 'string', text: source.slice(index, end) })
      index = end
      continue
    }

    if (/[0-9]/.test(character)) {
      let cursor = index
      while (cursor < source.length && /[0-9a-fA-FxXoObBeE._+-]/.test(source[cursor] ?? '')) {
        // A `+`/`-` only continues a number directly after an exponent, which keeps `a-1` an operator.
        const previous = source[cursor - 1] ?? ''
        if ((source[cursor] === '+' || source[cursor] === '-') && !/[eE]/.test(previous)) break
        cursor += 1
      }
      flush()
      pieces.push({ kind: 'number', text: source.slice(index, cursor) })
      index = cursor
      continue
    }

    if (isWordStart(character)) {
      let cursor = index
      while (cursor < source.length && isWordPart(source[cursor] ?? '')) cursor += 1
      const word = source.slice(index, cursor)
      if (keywords.has(word)) {
        flush()
        pieces.push({ kind: 'keyword', text: word })
      } else {
        plain += word
      }
      index = cursor
      continue
    }

    plain += character
    index += 1
  }
  flush()
  return pieces
}

const CLASSES: Readonly<Record<string, string>> = {
  comment: 'tok-comment',
  string: 'tok-string',
  number: 'tok-number',
  keyword: 'tok-keyword',
}

/**
 * Render source as line-numbered, escaped, lightly highlighted markup.
 *
 * Every line is one `<span class="line">`, whose first child is the number in a non-selectable gutter:
 * the number is presentation, so selecting the panel and copying it gets the source and not the
 * numbers.
 */
export function renderCode(source: string, language: string): string {
  const pieces = scan(source.replace(/\r\n?/g, '\n'), language)
  const out: string[] = ['<code class="code">']
  let line = 1
  let open = false
  const startLine = (): void => {
    out.push(`<span class="line"><span class="ln">${line}</span>`)
    open = true
  }
  startLine()
  for (const piece of pieces) {
    if (piece.kind === 'newline') {
      out.push('\n')
      if (open) out.push('</span>')
      line += 1
      startLine()
      continue
    }
    const className = CLASSES[piece.kind]
    out.push(className === undefined ? escapeHtml(piece.text) : `<span class="${className}">${escapeHtml(piece.text)}</span>`)
  }
  if (open) out.push('</span>')
  out.push('</code>')
  return out.join('')
}

/** Decide how to show one file's text, and produce the markup when there is any. */
export function renderSource(path: string, text: string): Rendered {
  const decision = rendererFor(path)
  if (decision.renderer === 'markdown') return { renderer: 'markdown', html: `<div class="markdown">${renderMarkdown(text)}</div>` }
  if (decision.renderer === 'code' && decision.language !== undefined) {
    return { renderer: 'code', language: decision.language, html: renderCode(text, decision.language) }
  }
  return { renderer: 'text' }
}
