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
 * The parser, configured once.
 *
 * `gfm` stays on because it is the dialect a document in a repository is written in. `breaks` stays **off**: one
 * newline inside a paragraph is a space in that dialect, and turning it on reflows every wrapped line of prose
 * into its own line.
 */
const marked = new Marked({ gfm: true, breaks: false })

/**
 * Colour the code, through the marked plugin for the two libraries.
 *
 * Both are zero-dependency, and the plugin is what lets a fence keep its language while the highlighter colours it —
 * `class="language-ts"` on the `<code>`, and the highlighter's own `hljs-` spans inside. The allow-list accepts both
 * because it permits `span`, `class` and `pre`, and **nothing else** the highlighter could emit.
 */
marked.use(
  markedHighlight({
    langPrefix: 'language-',
    highlight: (code: string, language: string) => highlightCode(code, language),
  }),
)

marked.use({
  renderer: {
    /**
     * Refuse a scheme rather than emit it, and keep the label so the document still reads with the reason beside
     * it — a reader who saw a link in the source should see what became of it.
     */
    link({ href, title, text }: Tokens.Link): string {
      const target = safeUrl(href)
      if (target === null) return `${text} (link refused)`
      const heading = title === null || title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return `<a href="${escapeHtml(target)}" rel="noreferrer noopener"${heading}>${text}</a>`
    },
    /** An image with a refused source becomes its alt text, so nothing is fetched and nothing is lost. */
    image({ href, title, text }: Tokens.Image): string {
      const target = safeUrl(href)
      if (target === null) return escapeHtml(text)
      const heading = title === null || title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}"${heading}>`
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
  return sanitizeHtml(marked.parseInline(String(text ?? '')) as string, { url: safeUrl })
}

/**
 * Render a document to HTML.
 *
 * A leading YAML block is lifted out and shown as metadata rather than parsed: every document in this repository
 * opens with frontmatter, and as markdown it renders as a horizontal rule and a heading made of the first key.
 */
export function renderMarkdown(source: string): string {
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = front === null ? text : text.slice(front[0].length)
  const frontHtml =
    front === null
      ? ''
      : `<section class="frontmatter"><h2>frontmatter</h2><pre><code>${escapeHtml((front[1] ?? '').trim())}</code></pre></section>\n`
  return sanitizeHtml(frontHtml + (marked.parse(body) as string), { url: safeUrl })
}
