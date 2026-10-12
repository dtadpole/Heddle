import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { writeFileSync } from 'node:fs'

import { fixtureDir, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier — the document view.
 *
 * Judges one claim: a markdown document is **rendered as a document**, by default, on the right-hand side —
 * and a document cannot use the renderer to inject markup.
 *
 * Both halves need saying. The first is what the owner asked for: a repository is largely `.md`, and reading
 * one as a wall of source is the wrong default. The second is the property that makes the first safe, and it
 * is the kind that fails **silently**: a renderer that passes a document's own tags through looks correct and
 * executes whatever the document says.
 *
 * It is judged in a real browser for the same reason the other view checks are: a document view that answers
 * `200` and shows raw markup is indistinguishable from a working one over HTTP.
 */

const CAPABILITY = 'a default renderer for markdown, shown on the right-hand side'

/** Start the Web UI in a directory whose documents are known, and resolve once it prints its URL. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const { join: joinPath } = await import('node:path')
      const child = spawn(process.execPath, [joinPath(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      })
    })()
  })
}

async function handshakeCookie(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from ${url} (HTTP ${response.status})`)
  return set.split(';')[0]
}

/** Whether this build serves a Web UI at all. */
async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the document API lists documents, renders one, and refuses what is not one', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('docs')
  const work = fixtureDir('docs')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin

    const listing = await (await fetch(`${origin}/api/docs`, { headers: { cookie } })).json()
    assert.ok(Array.isArray(listing.docs), 'the listing holds documents')
    assert.ok(listing.docs.length > 0, `and finds the repository's markdown (${listing.docs.length})`)
    assert.ok(
      listing.docs.every((entry) => /\.(?:md|markdown|mdx)$/i.test(entry.path)),
      'every entry is a markdown document',
    )
    assert.ok(
      listing.docs.every((entry) => !entry.path.includes('node_modules')),
      'and none of them is inside a dependency tree',
    )
    /**
     * Sorted by the same rule twice, rather than by JavaScript's default sort: the listing orders paths with
     * `localeCompare`, and a check that re-sorted them with `<` compared two different collations — measured,
     * and it reported `_context_/…` ahead of `AGENTS.md` as a failure of the listing when it was a failure of
     * the check.
     */
    const paths = listing.docs.map((entry) => entry.path)
    assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)), 'the order is stable and sorted')
    assert.equal(new Set(paths).size, paths.length, 'and no document is listed twice')

    const one = await (await fetch(`${origin}/api/docs?path=${encodeURIComponent(listing.docs[0].path)}`, { headers: { cookie } })).json()
    assert.ok(typeof one.html === 'string' && one.html.length > 0, 'a document renders to HTML')
    assert.match(one.html, /<h[1-6]>|<p>/, 'with block markup rather than the source')

    /**
     * The refusals. A document view that can be asked for an arbitrary file is a disclosure hole with a
     * renderer in front of it, and each rule is judged because each is a different way in.
     */
    for (const [path, why] of [
      ['../../.ssh/id_rsa', 'a path outside the root'],
      ['../package.json', 'a path beside the root'],
      ['package.json', 'a file that is not markdown'],
      ['no-such-document.md', 'a document that does not exist'],
    ]) {
      const refused = await fetch(`${origin}/api/docs?path=${encodeURIComponent(path)}`, { headers: { cookie } })
      const body = await refused.json()
      assert.ok(refused.status >= 400 && typeof body.error === 'string', `${why} is refused (HTTP ${refused.status})`)
      assert.equal(body.html, undefined, 'and no HTML comes back')
    }
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a browser renders the document as a document, and a document cannot inject markup', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('docs-view')
  const work = fixtureDir('docs-view')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("views") !== null', 20_000)

    const tabs = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#views button')].map((b) => b.textContent))`))
    assert.deepEqual(tabs, ['Chat', 'Trajectory', 'Docs'], 'the view ring offers the document view')

    await browser.evaluate(`document.querySelector('#views button[data-view="docs"]').click()`)
    assert.ok(await browser.waitFor('document.querySelectorAll("#docs-list li").length > 0', 20_000), 'the document list filled')
    assert.ok(await browser.waitFor('document.getElementById("doc").innerText.length > 0', 20_000), 'and a document rendered')

    const drawn = JSON.parse(
      await browser.evaluate(`(() => {
        const pane = document.getElementById('doc')
        return JSON.stringify({
          headings: pane.querySelectorAll('h1, h2, h3').length,
          paragraphs: pane.querySelectorAll('p').length,
          codeBlocks: pane.querySelectorAll('pre code').length,
          lists: pane.querySelectorAll('ul, ol').length,
          links: pane.querySelectorAll('a').length,
          frontmatter: pane.querySelectorAll('.frontmatter').length,
          showsSource: /^#{1,6}\\s/m.test(pane.innerText) || pane.innerText.includes(']('),
          chatHidden: document.getElementById('log').hidden,
          ledgerHidden: document.getElementById('ledger').hidden
        })
      })()`),
    )
    assert.ok(drawn.headings > 0, `headings render as headings (${drawn.headings})`)
    assert.ok(drawn.paragraphs > 0, 'paragraphs render as paragraphs')
    assert.ok(drawn.codeBlocks > 0, 'fenced code renders as a code block')
    assert.ok(drawn.lists > 0, 'lists render as lists')
    assert.equal(drawn.showsSource, false, 'and the reader is not shown markdown source instead')
    assert.ok(drawn.frontmatter > 0, 'a document that opens with frontmatter shows it as metadata')
    /**
     * A table **is** a table.
     *
     * The owner reported it: a document's tables were rendered as text, and a table is the one construct where
     * "shown as text" is not a readable fallback — the columns are the information. Judged in the browser as well
     * as in the unit tests, because the markup can be right and the cells run together with no borders, which
     * reads as a paragraph of pipes.
     */
    const table = JSON.parse(
      await browser.evaluate(`(() => {
        const pane = document.getElementById('doc')
        /**
         * The wrapper matters: the server writes a div carrying the markdown class around a rendered document,
         * and the styles hang off that class so both panes share them. Injecting a bare table measured a table with
         * no border, which was the check being wrong about what the server produces. No backticks in this comment
         * either: the block lives inside a template literal, and one closes it.
         */
        pane.innerHTML = ${JSON.stringify(
          '<div class="markdown"><table><thead><tr><th>Part</th><th>Claims</th></tr></thead><tbody><tr><td>1</td><td>10</td></tr></tbody></table></div>',
        )}
        const element = pane.querySelector('table')
        if (element === null) return JSON.stringify({ found: false })
        const header = element.querySelector('thead th')
        const cell = element.querySelector('tbody td')
        const headerStyle = getComputedStyle(header)
        const cellStyle = getComputedStyle(cell)
        return JSON.stringify({
          found: true,
          headerCells: element.querySelectorAll('thead th').length,
          bodyCells: element.querySelectorAll('tbody td').length,
          bordered: headerStyle.borderTopWidth !== '0px' && cellStyle.borderTopWidth !== '0px',
          padded: parseFloat(cellStyle.paddingLeft) > 0,
          headerDiffersFromCell: headerStyle.backgroundColor !== cellStyle.backgroundColor
        })
      })()`),
    )
    assert.ok(table.found, 'a table element renders')
    assert.equal(table.headerCells, 2, 'with its header cells')
    assert.equal(table.bodyCells, 2, 'and its body cells')
    assert.ok(table.bordered, 'each cell has a border, so the columns are visibly columns')
    assert.ok(table.padded, 'and padding, so the text is not against the rule')
    assert.ok(table.headerDiffersFromCell, 'with a header that reads as a header')

    /**
     * Code is **coloured**, and a fence in a language the build does not know is still rendered.
     *
     * Both halves matter: highlighting is a presentation of code that is already correct, so the failure worth
     * guarding is losing the block, not colouring it imperfectly. Judged in the browser because the spans can be
     * present in the markup and invisible — that is what a missing theme looks like.
     */
    const coloured = JSON.parse(
      await browser.evaluate(`(async () => {
        const pane = document.getElementById('doc')
        const response = await fetch('/api/docs?path=' + encodeURIComponent('README.md'))
        const body = await response.json()
        pane.innerHTML = body.html
        const spans = [...pane.querySelectorAll('pre code span[class^="hljs-"]')]
        /**
         * Read as the **distinct token classes** the highlighter emitted, and the colours the theme gives them.
         * Counting colours alone was fragile: it depended on the documents a checkout happens to hold, so a
         * README with one kind of token made this fail while the theme was working. A theme is in force when the
         * spans carry more than one class and those classes resolve to different colours.
         */
        const classes = [...new Set(spans.map((span) => span.className))]
        const colours = [...new Set(spans.map((span) => getComputedStyle(span).color))]
        const languages = [...new Set([...pane.querySelectorAll('pre code')].map((code) => code.className).filter((name) => name.includes('language-')))]
        return JSON.stringify({ spans: spans.length, classes: classes.length, colours: colours.length, languages })
      })()`),
    )
    assert.ok(coloured.languages.length > 0, `the served document has fenced code with a language (${JSON.stringify(coloured.languages)})`)
    assert.ok(coloured.spans > 0, `and its code is tokenised by the highlighter (${coloured.spans} spans)`)
    assert.ok(coloured.classes > 1, `with more than one kind of token (${JSON.stringify(coloured)})`)
    assert.ok(
      coloured.colours > 1,
      `and those tokens resolving to different colours, so a theme is in force rather than the classes alone (${coloured.colours})`,
    )
    assert.ok(drawn.chatHidden && drawn.ledgerHidden, 'while the other two views are off screen')

    /**
     * The injection claim, made against the page rather than the renderer alone: a document's own tags must not
     * become elements. This is the property that fails silently, so it is asserted in the browser where it
     * would actually execute.
     */
    const injected = JSON.parse(
      await browser.evaluate(`(async () => {
        const pane = document.getElementById('doc')
        const response = await fetch('/api/docs?path=' + encodeURIComponent('README.md'))
        const body = await response.json()
        const before = pane.innerHTML
        pane.innerHTML = body.html
        return JSON.stringify({ scripts: pane.querySelectorAll('script').length, innerBefore: before.length > 0 })
      })()`),
    )
    assert.equal(injected.scripts, 0, 'rendering a document produces no script element')
    assert.ok(injected.innerBefore, 'and the check ran against a rendered document')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a markdown file opened from the tree is rendered with the same styling as the document view', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('docs-file')
  const work = fixtureDir('docs-file')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    /**
     * The claim the owner found by clicking, and the one no check could see before it.
     *
     * A file opened from the left panel renders through a **second pane** — `#file-body` rather than `#doc`, the
     * Docs pane's own element — while the markdown styles were written against that id alone. So the markup was
     * right and every document opened from the tree arrived **unstyled**: a table with no borders, and an inline
     * code span showing its backticks instead of a code element.
     *
     * The document is taken from the server's own tree listing and rendered by the server's own route, so nothing
     * here depends on a fixture file being inside the document root or on which documents a checkout happens to
     * hold. Then the server's markup is put in the file pane and the styling is measured, because "rendered" and
     * "rendered and styled" are one selector apart.
     */
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    const listing = await (await fetch(`${origin}/api/docs`, { headers: { cookie } })).json()
    const wanted = (listing.docs ?? []).find((entry) => !entry.path.includes('/'))
    assert.ok(wanted !== undefined, `the repository has a document at its root to open (${(listing.docs ?? []).length} found)`)

    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("file-body") !== null', 20_000)

    const markup = await browser.evaluate(`(async () => {
      const body = await (await fetch('/api/docs?path=' + encodeURIComponent(${JSON.stringify(wanted.path)}))).json()
      const pane = document.getElementById('file-body')
      pane.dataset.renderer = 'markdown'
      pane.innerHTML = '<div class="markdown">' + body.html + '</div>'
      return document.querySelectorAll('#file-body table').length
    })()`)
    assert.ok(markup > 0, `the document rendered a table to style (${markup})`)

    const styled = JSON.parse(
      await browser.evaluate(`(() => {
        const body = document.getElementById('file-body')
        const header = body.querySelector('table th')
        const heading = body.querySelector('h1')
        const cells = [...body.querySelectorAll('table td')]
        const BACKTICK = String.fromCharCode(96)
        return JSON.stringify({
          table: header !== null,
          tableBorder: header === null ? null : getComputedStyle(header).borderTopWidth,
          inlineCodeBackground: (() => { const c = body.querySelector('p code'); return c === null ? null : getComputedStyle(c).backgroundColor })(),
          headingSize: heading === null ? null : parseFloat(getComputedStyle(heading).fontSize),
          bodySize: parseFloat(getComputedStyle(body).fontSize),
          codeInTable: body.querySelectorAll('table code').length,
          cellsShowingLiteralBacktick: cells.filter((cell) => cell.innerText.indexOf(BACKTICK) !== -1).length
        })
      })()`),
    )
    assert.ok(styled.table, 'the document has a table, which is what makes the styling visible')
    assert.notEqual(styled.tableBorder, '0px', `its cells are bordered (${styled.tableBorder})`)
    assert.notEqual(styled.inlineCodeBackground, 'rgba(0, 0, 0, 0)', 'and an inline code span has its own background')
    assert.ok(styled.headingSize > styled.bodySize, `a heading is larger than the body text (${styled.headingSize} vs ${styled.bodySize})`)
    assert.ok(styled.codeInTable > 0, 'a code span inside a link label is a code element')
    assert.equal(styled.cellsShowingLiteralBacktick, 0, 'and no cell shows a literal backtick')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
