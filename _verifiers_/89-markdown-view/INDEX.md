---
title: Verifier — Markdown View
version: 1.0.0
description: a markdown document renders as a document on the right-hand side, and cannot inject markup.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a default renderer for markdown on the right side
---

# `89-markdown-view`

Instance of this project's `_verifiers_`. **The claim it decides:** a markdown document is **rendered as a
document**, by default, on the right-hand side — and a document cannot use the renderer to inject markup.

## Why both halves are claims

The first is what was asked for: a repository is largely `.md`, and reading one as a wall of source is the wrong
default. The second is the property that makes the first safe, and it is the kind that fails **silently** — a
renderer that passes a document's own tags through looks correct and executes whatever the document says. A
document here is untrusted text: it comes from a model, a repository, or a person.

## What it must get right

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | the view ring offers Docs, and the document renders in the pane | a list that fills beside an empty pane looks like a slow load |
| 2 | headings, paragraphs, fenced code, lists and links become markup, and the source is **not** what is shown | "rendered" and "shown as source" are one CSS mistake apart |
| 3 | a document that opens with YAML frontmatter shows it as metadata | every document in this repository does, and as prose it reads as a sentence |
| 4 | a document cannot produce a `script` element, or an attribute of its own | the property that fails silently |
| 5 | a path outside the document root, and a file that is not markdown, are refused | a document view that can be asked for any file is disclosure with a renderer in front |
| 6 | the listing is stable and holds no dependency trees | a listing that reshuffles, or lists `node_modules`, is unusable |

## How it is judged

Two checks. The API one judges the listing, one rendered document, and all four refusals. The browser one
judges that the pane shows markup, that the source is not what a reader sees, that frontmatter is metadata, and
that rendering a document produces no `script` element — asserted **in the browser**, where injection would
actually execute.

The renderer itself is judged by unit tests beside it in `test/markdown.test.ts`, because escaping and emphasis
are decisions a browser check cannot isolate.

## Which library renders it, and why that is not a gap in the judging

Rendering is **`marked`** 18.1.0 — **zero dependencies**, 520 KB — adopted on the owner's instruction of
2026-10-11 to use an existing renderer rather than a written one. The candidates that were measured:
`markdown-it` (6 dependencies), `micromark` (several packages), `commonmark` (3), `snip`-style micro renderers
(zero but a fraction of the function).

`marked` does **not** sanitize its output, and says so; `href="javascript:…"` is emitted without complaint. So the
two guarantees below are still asserted here, and **the unit tests that assert them were not changed to suit the
library** — they were the acceptance test for adopting one. The guarantee moved from the renderer to an
allow-list over the library's output, because the parser is now someone else's code:

1. only the elements and attributes a document view uses survive (`src/server/sanitize.ts`, with its own tests);
2. a link's scheme is checked in the parser's own hook.

## What it deliberately does not judge

- **Every corner of the specification.** The library covers far more than the written renderer did — nested
  lists, reference links, task lists — and none of that is claimed here beyond what a check exercises.
- **Raw HTML in a document.** It is dropped by the allow-list, which is the design rather than a gap: a document
  that could write markup could run script.
- **Syntax highlighting.** Code keeps its language as a class (`language-ts`) and is otherwise exact. Colouring
  it needs a highlighter — `highlight.js` and `prismjs` are both zero-dependency candidates — and it is a
  separate feature with its own judging.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser is
the `3` case.
