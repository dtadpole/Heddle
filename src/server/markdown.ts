/**
 * A small Markdown renderer, for showing a document as a document.
 *
 * Written rather than installed, and that is a decision worth stating: heddle carries four runtime
 * dependencies, and a full CommonMark implementation is several times the size of the whole UI. What a
 * reader needs here is a **document view** — headings, paragraphs, lists, code, emphasis, links, rules,
 * quotes — not every corner of the specification.
 *
 * Two rules matter more than the feature list:
 *
 * - **Everything is escaped first.** A document is untrusted text: it comes from a model, a repository, or a
 *   person, and any of them can contain `<script>`. Every renderer path escapes, and the only tags in the
 *   output are the ones this file writes. A test asserts that, because it is the property that fails
 *   silently.
 * - **Anything not understood is shown, not dropped.** An unknown construct becomes an escaped paragraph.
 *   A renderer that swallows what it does not recognise loses the reader's text without saying so.
 */

/** Escape the five characters that can start a tag, an entity, or a quote break-out. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Whether a link's target may be followed.
 *
 * A renderer that passes a `javascript:` URL through is handing a document the ability to run code, and saying
 * "the browser decides" is not a defence — the browser follows what it is given. Relative targets, fragments,
 * and the three schemes a document legitimately links to are allowed; everything else becomes text.
 */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed.length === 0) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return /^(?:https?|mailto):/i.test(trimmed) ? trimmed : null
  }
  return trimmed
}

/** Find the `)` that closes a `(`-balanced link target, so `alert(1)` cannot end it early. */
function closingParen(text: string, from: number): number {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return -1
}

/** An image or a link at `start`, or `null` when the text there is not one. */
function linkAt(text: string, start: number): { readonly kind: 'image' | 'link'; readonly label: string; readonly url: string; readonly end: number } | null {
  const image = text.startsWith('![', start)
  const open = image ? start + 2 : text.startsWith('[', start) ? start + 1 : -1
  if (open === -1) return null
  const labelEnd = text.indexOf(']', open)
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null
  const urlStart = labelEnd + 2
  const urlEnd = closingParen(text, urlStart)
  if (urlEnd === -1) return null
  return {
    kind: image ? 'image' : 'link',
    label: text.slice(open, labelEnd),
    url: text.slice(urlStart, urlEnd),
    end: urlEnd + 1,
  }
}

/**
 * Inline spans, applied to already-escaped text.
 *
 * A scanner rather than a set of regexes, and the change was forced by a test: the regex for a link target
 * stopped at the first `)`, so `[click](javascript:alert(1))` produced the href `javascript:alert(1` and a
 * stray `)` — a URL cut in half. Balanced parentheses are what a target can contain, and finding the end of
 * one is a scan, not a match.
 *
 * Code spans are pulled out before anything else, because `**` inside a code span is literal — a renderer that
 * bolds inside code is wrong in a way a reader notices immediately in a document about code.
 */
export function renderInline(escaped: string): string {
  const out: string[] = []
  let index = 0
  while (index < escaped.length) {
    const character = escaped[index]

    /** A code span: everything to the matching backtick is literal. */
    if (character === '`') {
      const close = escaped.indexOf('`', index + 1)
      if (close !== -1) {
        out.push(`<code>${escaped.slice(index + 1, close)}</code>`)
        index = close + 1
        continue
      }
    }

    if (character === '[' || (character === '!' && escaped[index + 1] === '[')) {
      const found = linkAt(escaped, index)
      if (found !== null) {
        const target = safeUrl(found.url)
        if (found.kind === 'image') {
          out.push(target === null ? found.label : `<img alt="${found.label}" src="${target}">`)
        } else if (target === null) {
          /** A refused scheme keeps the label as text, so the document still reads and nothing is followed. */
          out.push(`${found.label} (link refused)`)
        } else {
          out.push(`<a href="${target}" rel="noreferrer noopener">${found.label}</a>`)
        }
        index = found.end
        continue
      }
    }

    /** Emphasis, matched at the position the scanner has reached so a code span cannot be caught by it. */
    if (escaped.startsWith('**', index)) {
      const close = escaped.indexOf('**', index + 2)
      if (close !== -1) {
        out.push(`<strong>${escaped.slice(index + 2, close)}</strong>`)
        index = close + 2
        continue
      }
    }
    if (escaped.startsWith('~~', index)) {
      const close = escaped.indexOf('~~', index + 2)
      if (close !== -1) {
        out.push(`<del>${escaped.slice(index + 2, close)}</del>`)
        index = close + 2
        continue
      }
    }
    if (character === '*') {
      const close = escaped.indexOf('*', index + 1)
      if (close !== -1 && close > index + 1) {
        out.push(`<em>${escaped.slice(index + 1, close)}</em>`)
        index = close + 1
        continue
      }
    }

    out.push(character ?? '')
    index += 1
  }
  return out.join('')
}

/**
 * Render a document to HTML.
 *
 * Block-level constructs only, one pass, no nesting beyond a list's own items. That covers what a document
 * view shows and keeps the function small enough to reason about — and every line it does not recognise is
 * still rendered, as a paragraph.
 */
export function renderMarkdown(source: string): string {
  /**
   * A leading YAML block is **lifted out**, not rendered as text.
   *
   * Measured: `title: heddle version: 0.3.0 description: …` appeared as the first paragraph of every document in
   * this repository, because every one of them opens with frontmatter — which is metadata, not prose, and
   * reading it as a sentence is worse than not showing it. It comes back as a titled block so the reader knows
   * the document declared something rather than that the renderer dropped it.
   */
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = front === null ? text : text.slice(front[0].length)
  const frontHtml =
    front === null
      ? ''
      : `<section class="frontmatter"><h2>frontmatter</h2><pre><code>${escapeHtml((front[1] ?? '').trim())}</code></pre></section>\n`
  const lines = body.split('\n')
  const out: string[] = []
  /** The open list, so consecutive items join one list rather than many. */
  let list: 'ul' | 'ol' | null = null
  let paragraph: string[] = []
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(`<p>${renderInline(escapeHtml(paragraph.join(' ')))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list !== null) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    out.push(`<blockquote>${renderInline(escapeHtml(quote.join(' ')))}</blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    /** A fenced block runs to its closing fence, or to the end when there is none — never dropped. */
    const fence = /^\s*(?:```|~~~)\s*([A-Za-z0-9+#-]*)\s*$/.exec(line)
    if (fence !== null) {
      flushAll()
      const language = fence[1] ?? ''
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      out.push(
        `<pre><code${language.length > 0 ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`,
      )
      continue
    }

    if (/^\s*$/.test(line)) {
      flushAll()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushAll()
      const level = (heading[1] ?? '#').length
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2] ?? ''))}</h${level}>`)
      continue
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }

    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      flushQuote()
      const wanted: 'ul' | 'ol' = /^\s*\d/.test(line) ? 'ol' : 'ul'
      if (list !== wanted) {
        flushList()
        out.push(`<${wanted}>`)
        list = wanted
      }
      out.push(`<li>${renderInline(escapeHtml(item[1] ?? ''))}</li>`)
      continue
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line)
    if (quoted !== null) {
      flushParagraph()
      flushList()
      quote.push(quoted[1] ?? '')
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line.trim())
  }

  flushAll()
  return frontHtml + out.join('\n')
}
