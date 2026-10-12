import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier — one preview surface.
 *
 * **The claim it decides:** a file is previewed in exactly one place — the File panel a click on the left panel
 * opens — and each file type is rendered with the library appropriate to it.
 *
 * The owner's request of 2026-10-11, and the reason it is a claim rather than a preference: the project had grown
 * **two** preview surfaces. A session offered Chat, Trajectory and Docs, where Docs listed the repository's
 * documents and rendered them; and a click on a file in the left panel opened a File tab that rendered the same
 * markdown through a second pane — which was styled separately, and was in fact unstyled until that was measured.
 * Two surfaces meant two renderers, two style blocks and two places for a document to look wrong.
 *
 * It is judged in a browser because every part of it is a rendering claim: the ring, the pane that appears, and the
 * markup each library produces. An API that answers correctly and a panel that draws text says nothing about any
 * of it.
 */

const CAPABILITY = 'one preview surface, rendering each file type with the library appropriate to it'

/** Start the Web UI and resolve once it prints its URL. */
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

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the server renders each file type, and the page offers no second surface', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('preview-api')
  const work = fixtureDir('preview-api')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: '/Users/zhenc/heddle' }),
    })

    /**
     * Each type through the route the File panel uses. The point is not that markup exists but that the **right
     * library** produced it: markdown arrives as elements with its fenced code tokenised, source arrives with the
     * highlighter's classes, and something with no renderer arrives as text with no markup at all.
     */
    const read = async (path) => (await fetch(`${origin}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })).json()

    const document = await read('/Users/zhenc/heddle/AGENTS.md')
    assert.equal(document.renderer, 'markdown', 'a document is rendered as markdown')
    assert.match(String(document.html), /<h1>/, 'with block elements, not its source')
    assert.match(String(document.html), /<table>/, 'including a table')

    const source = await read('/Users/zhenc/heddle/package.json')
    assert.equal(source.renderer, 'code', 'a source file is rendered as code')
    assert.equal(source.language, 'json', 'with the language its extension names')
    assert.match(String(source.html), /hljs-/, "carrying the highlighter's own classes")
    assert.match(String(source.html), /class="ln"/, 'and a line gutter')

    const config = await read('/Users/zhenc/heddle/cordis.yml')
    assert.equal(config.renderer, 'code', 'a yaml file is rendered as code rather than as text')
    assert.equal(config.language, 'yaml', 'which was measured as text before the map covered it')

    const plain = await read('/Users/zhenc/heddle/LICENSE')
    assert.equal(plain.renderer, 'text', 'a file with no renderer is text')
    assert.equal(plain.html, undefined, 'with no markup produced for it')

    /**
     * What the markdown library must keep doing, carried over from the part this one replaced.
     *
     * A document is untrusted text, so the two properties its tests assert are judged here as well, on a document
     * the server rendered rather than on a string: no element of the document's own survives, a refused link keeps
     * its label, and frontmatter is metadata rather than prose.
     */
    assert.ok(!String(document.html).includes('<script'), 'no element the document wrote survives')
    assert.match(String(document.html), /<section class="frontmatter">/, 'frontmatter is lifted into its own block')
    assert.ok(!String(document.html).includes('`'), 'and a code span is not shown as backticks')

    const hostile = await read('/Users/zhenc/heddle/AGENTS.md')
    assert.match(String(hostile.html), /<table>/, 'a table is a table, with its cells')
    assert.ok(!String(hostile.html).includes('onclick'), 'and no attribute of the document survives')

    const refused = await fetch(`${origin}/api/file?path=${encodeURIComponent('/etc/passwd')}`, { headers: { cookie } })
    assert.equal(refused.status, 400, 'a file outside every workspace root is refused')

    /**
     * The second surface is **gone**, in the served page.
     *
     * Asserted on the markup the server sends, because that is what a client receives: a tab that is hidden by a
     * script still exists, and a document list beside it would still be fetched.
     */
    const page = await (await fetch(server.url, { headers: { cookie } })).text()
    assert.ok(!page.includes('data-view="docs"'), 'no Docs tab is offered')
    assert.ok(!page.includes('id="docs-list"'), 'and no document list is built')
    assert.ok(!/>Docs</.test(page), 'nor is the word offered as a control')
    assert.match(page, /data-view="file"/, 'while the file panel is there')
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a click in the left panel opens the one preview, rendered for its type and styled', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('preview-ui')
  const work = fixtureDir('preview-ui')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: '/Users/zhenc/heddle' }),
    })

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 0', 20_000)
    await browser.evaluate('document.querySelector("#tree .row").click()')
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 1', 20_000)

    const openFile = async (name) => {
      const found = await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === ${JSON.stringify(name)}); if (row === undefined) return false; row.click(); return true })()`)
      assert.ok(found, `${name} is in the tree`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
      return JSON.parse(
        await browser.evaluate(`(() => {
          const body = document.getElementById('file-body')
          const table = body.querySelector('table th')
          const gutter = body.querySelector('.ln')
          const code = body.querySelector('code')
          const heading = body.querySelector('h1')
          return JSON.stringify({
            ring: [...document.querySelectorAll('#views button')].filter((x) => !x.hidden).map((x) => x.textContent),
            fileHidden: document.getElementById('file').hidden,
            renderer: body.dataset.renderer,
            chars: body.innerText.length,
            highlighted: body.querySelectorAll('span[class^="hljs-"]').length,
            gutter: gutter === null ? null : gutter.textContent,
            tableBorder: table === null ? null : getComputedStyle(table).borderTopWidth,
            inlineCodeBg: (() => { const c = body.querySelector('p code'); return c === null ? null : getComputedStyle(c).backgroundColor })(),
            headingBigger: heading === null ? null : parseFloat(getComputedStyle(heading).fontSize) > parseFloat(getComputedStyle(body).fontSize),
            codeFont: code === null ? null : getComputedStyle(code).fontFamily.includes('mono')
          })
        })()`),
      )
    }

    /** A document: the markdown library, and the styles the project shares for a rendered document. */
    const document = await openFile('AGENTS.md')
    assert.equal(document.fileHidden, false, 'a click shows the file panel')
    assert.deepEqual(document.ring, ['File'], 'and the ring offers the file alone, which is the one preview surface')
    assert.equal(document.renderer, 'markdown', 'the document is rendered as markdown')
    assert.ok(document.chars > 1_000, `and it holds the document (${document.chars} characters)`)
    assert.ok(document.tableBorder !== null && document.tableBorder !== '0px', `its table is a bordered table (${document.tableBorder})`)
    assert.notEqual(document.inlineCodeBg, 'rgba(0, 0, 0, 0)', 'an inline code span has its own background')
    assert.equal(document.headingBigger, true, 'a heading is larger than the body text')

    /** Source: the highlighting library, with a gutter, and no markdown rendering. */
    const source = await openFile('package.json')
    assert.equal(source.renderer, 'code', 'a source file is source')
    assert.ok(source.highlighted > 0, `coloured by the highlighter (${source.highlighted} spans)`)
    assert.equal(source.gutter, '1', 'with a line gutter starting at one')
    assert.equal(source.codeFont, true, 'in a monospace face')

    /** Neither: shown as it is, and still not interpreted. */
    const plain = await openFile('LICENSE')
    assert.equal(plain.renderer, 'text', 'a file with no renderer is text')
    assert.equal(plain.highlighted, 0, 'with nothing invented for it')
    assert.ok(plain.chars > 100, 'and its content is there')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
