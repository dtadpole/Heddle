import { isAbsolute, resolve } from 'node:path'

import { Marked, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'

import { highlightCode } from './highlight.ts'
import { sanitizeHtml } from './sanitize.ts'

/**
 * Markdown rendering, on **marked**.
 *
 * The first version of this file was a renderer written here. It was replaced on the owner's instruction on
 * 2026-10-11 — find an existing library with few dependencies and high function rather than writing one — and the
 * instruction was right on the evidence:
 *
 * - `marked` 18.1.0 has **zero dependencies** and 520 KB on disk, against four runtime dependencies for the whole
 *   harness, and a few times that size for `markdown-it`, `micromark` or `remark` once their trees are counted;
 * - it is maintained, and it renders constructs mine did not: nested lists, tables with alignment, autolinks,
 *   reference links, strikethrough, task lists, and the rest of GitHub-flavoured markdown.
 *
 * What it does **not** do is make any of that safe, and that is why this file still exists. `marked` documents
 * that it "does not sanitize the output HTML", and a document here is untrusted text — from a model, a repository,
 * or a person. So the two guarantees the written renderer had are kept here, and **the unit tests that assert them
 * are unchanged**: they were the acceptance test for adopting a library rather than something to relax for one.
 *
 * 1. **The library's output is reduced to an allow-list of elements and attributes**, so a document cannot produce
 *    a tag of its own. Measured: escaping the *source* first was wrong — `marked` escapes the escaped text again
 *    inside a code block, so `1 < 2` in a fence rendered as `&amp;lt;`. The guarantee belongs on the output when
 *    the parser is someone else's code, and it is an allow-list rather than a deny-list because a deny-list is a
 *    list of the attacks its author thought of.
 * 2. **A link's scheme is checked** in the renderer's own hook. Measured: `marked` emits `href="javascript:…"`
 *    without complaint, so the check has to be here.
 */

/** Escape the five characters that can start a tag, an entity, or a quote break-out. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Whether a link's target may be followed.
 *
 * Relative targets, fragments, and the three schemes a document legitimately links to are allowed; everything else
 * becomes text. A renderer that passes a `javascript:` URL through hands a document the ability to run code, and
 * "the browser decides" is not a defence — the browser follows what it is given.
 */
export function safeUrl(url: string): string | null {
  const trimmed = String(url ?? '').trim()
  if (trimmed.length === 0) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return /^(?:https?|mailto):/i.test(trimmed) ? trimmed : null
  }
  return trimmed
}

/**
 * Where an embedded subresource should be fetched from.
 *
 * A document's relative reference — `![icon](heddle.svg)` — means *beside this document*, and a browser resolves it
 * against the **page URL** instead, which is the server root. Measured: that request answered `404`, so a document
 * with an image in it showed alt text and a broken marker. The reference is therefore resolved against the
 * document's own folder and handed to the route that serves a file's bytes.
 *
 * A remote URL is left exactly as written: it is the author's choice, it is not this server's to re-host, and
 * `safeUrl` has already refused the schemes that would run code. A `data:` image is not a file at all, so it is
 * refused here — the alternative is a document smuggling an arbitrary payload into the page.
 */
function resolveImage(href: string, base: string | undefined): string | null {
  const trimmed = href.trim()
  if (trimmed.length === 0) return null
  if (/^(?:https?:)?\/\//i.test(trimmed) || trimmed.startsWith('data:')) return null
  if (base === undefined) return null
  /** A fragment or an absolute URL is not a file to look for beside the document. */
  if (trimmed.startsWith('#')) return null
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(base, trimmed)
  return `/api/raw?path=${encodeURIComponent(absolute)}`
}

/**
 * The parser, configured once.
 *
 * `gfm` stays on because it is the dialect a document in a repository is written in. `breaks` stays **off**: one
 * newline inside a paragraph is a space in that dialect, and turning it on reflows every wrapped line of prose
 * into its own line.
 */
const marked = new Marked({ gfm: true, breaks: false })

/**
 * The folder a document's relative images resolve against, for the parse in progress.
 *
 * One module-level value rather than a closure per document, because `marked`'s renderer hooks cannot be handed
 * per-call state: the parse is synchronous and single-threaded, so this is set immediately before a parse and read
 * during it. The setter below is the only writer.
 */
let imageBase: string | undefined

/**
 * A leading `_` is escaped, so a name is a name.
 *
 * Measured, and it is a defect this repository hits everywhere: `# _tools_` rendered as `<em>tools</em>`, so the
 * folder names this project is made of — `_tools_`, `_verifiers_`, `_context_`, `_projects_` — **lost their
 * underscores** in every document that named one. `snake_case` inside a word survives, because that case flanks a
 * word on both sides; a lone `_name_` does not, and CommonMark's rule about intraword underscores says nothing
 * about a name standing alone.
 *
 * The escape is markdown's own: a backslash makes the character literal, which is what a document that wanted a
 * literal underscore would have written. Asterisks still make emphasis, so `*italics*` and `**bold**` are
 * unaffected — only the leading `_` of an underscore-run is touched, and `_` is still allowed to mean `_` in the
 * middle of a word, which is where it was already safe.
 */
function escapeLeadingUnderscores(markdown: string): string {
  /**
   * Code is left alone, because a backslash **inside code is visible** — measured: a fence containing `_a_b_`
   * rendered as `\_a_b_`, and an escape that changes the text of code is worse than the emphasis it prevents. Code
   * spans keep their underscores without help, since emphasis does not run inside them.
   */
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/.exec(line)
    if (marker !== null) {
      const character = marker[1] ?? '```'
      if (fence === null) fence = character
      else if (fence === character) fence = null
      out.push(line)
      continue
    }
    if (fence !== null) {
      out.push(line)
      continue
    }
    /** A code span is `...`; the escape is applied to the parts that are not inside one. */
    out.push(
      line
        .split(/(`[^`]*`)/)
        .map((piece) => (piece.startsWith('`') ? piece : piece.replace(/(^|\s)_(?=[^\s_])/g, '$1\\_')))
        .join(''),
    )
  }
  return out.join('\n')
}

/**
 * Colour the code, through the marked plugin that pairs the two libraries.
 *
 * A fence keeps its language while the highlighter colours it: `class="language-ts"` on the `<code>`, and the
 * highlighter's own `hljs-` spans inside. The allow-list accepts both because it permits `span`, `class` and `pre`,
 * and nothing else the highlighter could emit.
 */
marked.use(
  markedHighlight({
    langPrefix: 'language-',
    highlight: (code: string, language: string) => highlightCode(code, language),
  }),
)

/**
 * The two renderer hooks that exist for safety, rather than for formatting.
 *
 * Both passed the label's **raw text** through at first, and that was a measured bug: a code span inside link text
 * rendered its backticks literally, so `[`x`](a.md)` — the shape this repository's index tables are full of — came
 * out as an anchor containing a backtick instead of a `code` element. `tokens` is what the parser already decided
 * the label means, and `this.parser` writes it exactly as it would be written outside a link, so emphasis and code
 * spans behave the same in both places. A label whose scheme is refused keeps its text, with the reason beside it,
 * so a reader who saw a link in the source sees what became of it.
 */
marked.use({
  renderer: {
    link(this: { parser: { parseInline(tokens: unknown[]): string } }, { href, title, tokens }: Tokens.Link): string {
      const label = this.parser.parseInline(tokens as unknown[])
      const target = safeUrl(href)
      if (target === null) return `${label} (link refused)`
      const heading = title === null || title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return `<a href="${escapeHtml(target)}" rel="noreferrer noopener"${heading}>${label}</a>`
    },
    /** An image with a refused source becomes its alt text, so nothing is fetched and nothing is lost. */
    image(this: { parser: { parseInline(tokens: unknown[]): string } }, { href, title, text, tokens }: Tokens.Image): string {
      const label = tokens === undefined ? escapeHtml(text) : this.parser.parseInline(tokens as unknown[])
      const target = safeUrl(href)
      if (target === null) return label
      /** The base is set per parse, so one document's relative images do not resolve against another's. */
      const source = resolveImage(target, imageBase) ?? target
      const heading = title === null || title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return `<img src="${escapeHtml(source)}" alt="${escapeHtml(text)}"${heading}>`
    },
  },
})

/**
 * Render inline spans only — a title, a table cell, a label.
 *
 * The library's own inline parser, which is part of the point of using it: one implementation of emphasis and
 * code spans rather than two that can disagree.
 */
export function renderInline(text: string): string {
  return sanitizeHtml(marked.parseInline(escapeLeadingUnderscores(String(text ?? ''))) as string, { url: safeUrl })
}

/**
 * Render a document to HTML.
 *
 * A leading YAML block is lifted out and shown as metadata rather than parsed: every document in this repository
 * opens with frontmatter, and as markdown it renders as a horizontal rule and a heading made of the first key.
 */
export function renderMarkdown(source: string, options: { readonly base?: string } = {}): string {
  imageBase = options.base
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = front === null ? text : text.slice(front[0].length)
  const frontHtml =
    front === null
      ? ''
      : `<section class="frontmatter"><h2>frontmatter</h2><pre><code>${escapeHtml((front[1] ?? '').trim())}</code></pre></section>\n`
  return sanitizeHtml(frontHtml + (marked.parse(escapeLeadingUnderscores(body)) as string), {
    /**
     * One rule for images, wherever the tag came from.
     *
     * `marked` resolves a **markdown** image against the document's folder in its own renderer; raw HTML goes
     * around that renderer, so an `<img>` written by hand — which is the only way to centre one, since markdown
     * has no alignment — arrived here as a relative path the browser then resolved against the page URL, which
     * is the server root. The renderer and the fence now agree: a relative `src` on an image is beside the
     * document, and everything else is only scheme-checked.
     */
    url: (value, at) => {
      const safe = safeUrl(value)
      if (safe === null) return null
      /**
       * Only a **relative** reference is resolved here. `marked`'s own renderer has already done it for a markdown
       * image, so resolving again wrapped the route in itself (`/api/raw?path=%2Fapi%2Fraw…`) — measured as two
       * failing unit tests rather than as a broken page, because the tests came first.
       */
      const relative = !/^[a-z][a-z0-9+.-]*:/i.test(safe) && !safe.startsWith('/') && !safe.startsWith('#')
      if (at.tag === 'img' && at.attribute === 'src' && relative) return resolveImage(safe, imageBase) ?? safe
      return safe
    },
  })
}
