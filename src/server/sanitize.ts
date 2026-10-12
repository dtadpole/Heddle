/**
 * An allow-list over rendered HTML.
 *
 * The hand-written renderer escaped a document's text before writing it, which was correct because that renderer
 * wrote every tag itself. A library does not work that way: it parses the document, passes raw HTML through, and
 * escapes text in its own places. So the guarantee moves to the **output**, where it belongs when the parser is
 * someone else's code — and it has to be an allow-list.
 *
 * Why an allow-list rather than escaping the input, measured: pre-escaping the source made `marked` escape the
 * escaped text a second time inside a code block, so `1 < 2` in a fence rendered as `&amp;lt;`. A reader of a
 * document about code sees that immediately.
 *
 * Why an allow-list rather than a deny-list: a deny-list is a list of the attacks its author thought of. This
 * drops every element that is not one of the ones a document view shows, and every attribute that is not one of
 * the few carrying meaning — so `onclick`, `onerror`, `srcset`, `style` and whatever is invented next are all
 * refused by not being on the list.
 */

/** Elements a document view renders. Anything else is dropped, with its text kept. */
const ALLOWED = new Set([
  'a', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'input',
  'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Attributes a document view uses. `class` is here for the renderer's own language and frontmatter hooks. */
const ATTRS = new Set([
  'align', 'alt', 'checked', 'class', 'disabled', 'height', 'href', 'id', 'src', 'title', 'type', 'width',
  /**
   * `target` and `rel`, which a link to another site needs to open **beside** the document rather than replacing it.
   *
   * Measured: the renderer wrote `target="_blank"` for a remote link and the sanitizer dropped it with the other
   * unknown attributes, so following a link out of a document navigated away from the panel. `rel` comes with it
   * because `target="_blank"` without `noopener` lets the opened page reach back through `window.opener`, and this
   * renderer writes both together.
   */
  'target', 'rel',
])

/**
 * Attributes that may only be a **number of pixels**.
 *
 * A document that embeds an image may say how large it is shown, and it needs to: measured, the README's icon is
 * 560 units in the file and the owner asked for it at 160 in the document. Without these the document's wish was
 * dropped and every reader of this view saw the file's own size, while a reader of GitHub saw 160 — one document,
 * two sizes. The value is checked rather than trusted: these attributes are for a count of pixels, so a number is
 * what survives, and a document cannot reach the page's styling through them.
 */
const NUMERIC_ATTRS = new Set(['height', 'width'])

/** Elements whose **text** is not content: dropping the tag must drop what is inside it. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript'])

/** Attributes that carry a URL, and are therefore scheme-checked. The check itself is the caller's. */
const URL_ATTRS = new Set(['href', 'src'])

/**
 * The one attribute this project writes for its own use, listed by **name** rather than by its `data-` prefix.
 *
 * A prefix would turn an allow-list into a rule about spelling: a document could then set any `data-` attribute a
 * future script reads. Measured, and this is why it is here at all: the renderer marks a link that names a workspace
 * file with `data-heddle-path`, the sanitizer dropped it as an unknown attribute, and the panel had no way to know a
 * link was one to follow — the markup looked right, and clicking it navigated away from the document instead.
 */
const OWN_ATTRS = new Set(['data-heddle-path'])

export interface SanitizeOptions {
  /**
   * Decide whether a URL attribute may survive. Returning `null` drops the attribute.
   *
   * The **tag and attribute** are handed over as well as the value, because the two URL attributes are not the
   * same question: a link goes where it says, while a document's embedded image is *beside the document* and has
   * to be resolved against it. Measured: a caller that could see only the value had to decide by the string, so a
   * raw-HTML `<img src="icon.svg">` — which is how a centred image is written, since markdown cannot centre one
   * — was left unresolved and the browser asked the server root for it, which is the broken image this renderer
   * already fixed once for markdown images.
   */
  readonly url?: (value: string, at: { readonly tag: string; readonly attribute: string }) => string | null
}

/** Read an attribute whose value is quoted. Handles `"`, `'` and unquoted values, and entities are left alone. */
function readAttribute(html: string, from: number): { readonly name: string; readonly value: string; readonly end: number } | null {
  let index = from
  while (index < html.length && /\s/.test(html[index] ?? '')) index += 1
  const nameMatch = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*/.exec(html.slice(index))
  if (nameMatch === null) return null
  const name = nameMatch[0].toLowerCase()
  index += name.length
  while (index < html.length && /\s/.test(html[index] ?? '')) index += 1
  if (html[index] !== '=') return { name, value: '', end: index }
  index += 1
  while (index < html.length && /\s/.test(html[index] ?? '')) index += 1
  const quote = html[index]
  if (quote === '"' || quote === "'") {
    const close = html.indexOf(quote, index + 1)
    const stop = close === -1 ? html.length : close
    return { name, value: html.slice(index + 1, stop), end: stop + 1 }
  }
  const unquoted = /^[^\s>]*/.exec(html.slice(index))
  const value = unquoted === null ? '' : unquoted[0]
  return { name, value, end: index + value.length }
}

/**
 * Reduce rendered HTML to the elements and attributes a document view uses.
 *
 * The scanner walks the string once. Tag **names** and attribute names it does not recognise are dropped, and text
 * between tags is passed through unchanged, because it is text — the parser already escaped it, and escaping it
 * again would show `&lt;` to a reader.
 */
export function sanitizeHtml(html: string, options: SanitizeOptions = {}): string {
  const out: string[] = []
  const lower = html.toLowerCase()
  let index = 0

  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) {
      out.push(html.slice(index))
      break
    }
    out.push(html.slice(index, open))

    /** A comment or a declaration carries nothing a document view shows. */
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4)
      index = close === -1 ? html.length : close + 3
      continue
    }
    if (lower.startsWith('<!', open) || html.startsWith('<?', open)) {
      const close = html.indexOf('>', open)
      index = close === -1 ? html.length : close + 1
      continue
    }

    const closing = html[open + 1] === '/'
    const nameStart = open + (closing ? 2 : 1)
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(nameStart))
    /** A `<` that does not begin a tag is text, and is passed through rather than swallowed. */
    if (nameMatch === null) {
      out.push('&lt;')
      index = open + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    let cursor = nameStart + name.length
    const attributes: string[] = []
    let selfClosed = false

    while (cursor < html.length && html[cursor] !== '>') {
      if (html[cursor] === '/' && html[cursor + 1] === '>') {
        selfClosed = true
        cursor += 2
        break
      }
      if (html[cursor] === '/') {
        cursor += 1
        continue
      }
      const attribute = readAttribute(html, cursor)
      if (attribute === null) {
        cursor += 1
        continue
      }
      cursor = attribute.end
      if (!ATTRS.has(attribute.name) && !OWN_ATTRS.has(attribute.name)) continue
      if (NUMERIC_ATTRS.has(attribute.name)) {
        if (!/^\d{1,4}$/.test(attribute.value)) continue
        attributes.push(`${attribute.name}="${attribute.value}"`)
        continue
      }
      if (URL_ATTRS.has(attribute.name)) {
        const decided =
          options.url === undefined ? attribute.value : options.url(attribute.value, { tag: name, attribute: attribute.name })
        if (decided === null) continue
        attributes.push(`${attribute.name}="${decided.replace(/"/g, '&quot;')}"`)
        continue
      }
      attributes.push(attribute.value.length === 0 ? attribute.name : `${attribute.name}="${attribute.value.replace(/"/g, '&quot;')}"`)
    }
    if (cursor >= html.length && html[cursor] !== '>') {
      /** An unterminated tag: the rest is text. */
      out.push(html.slice(open))
      break
    }
    index = cursor + 1

    if (!ALLOWED.has(name)) {
      if (DROP_WITH_CONTENT.has(name) && !closing) {
        const closeTag = `</${name}`
        const close = lower.indexOf(closeTag, index)
        index = close === -1 ? html.length : close + closeTag.length
        const closeEnd = html.indexOf('>', index)
        index = closeEnd === -1 ? html.length : closeEnd + 1
      }
      continue
    }
    const head = attributes.length === 0 ? name : `${name} ${attributes.join(' ')}`
    out.push(closing ? `</${name}>` : `<${head}${selfClosed ? ' /' : ''}>`)
  }

  return out.join('')
}
