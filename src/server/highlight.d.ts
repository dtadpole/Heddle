/**
 * Types for the per-language entry points of `highlight.js`.
 *
 * The package ships `types/index.d.ts`, which declares the module `highlight.js` and its `LanguageFn` — but the
 * individual grammar paths (`highlight.js/lib/languages/bash`) have no declarations, and its `exports` map points
 * them at plain JavaScript. The import is therefore declared here rather than left implicitly `any`: the grammars
 * are the one thing in this module whose shape matters, because a wrong one would be registered silently.
 */
declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js'
  const language: LanguageFn
  export default language
}
