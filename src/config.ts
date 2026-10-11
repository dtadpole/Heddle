import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'

/**
 * The configuration model, borrowed from how DSH composes a profile.
 *
 * DSH's shape is the one this mirrors, and the parts worth naming are:
 *
 * - **The base tree is empty.** A profile's `cordis.yml` is `[]`, and the whole
 *   tree arrives as patch layers over it. That is why no plugin in this project
 *   needs to know about any other: composition is data, not imports.
 * - **A layer addresses rows by `id`.** The last write wins, so a later layer can
 *   restate one row's whole config without touching the rest of the tree.
 * - **Row order carries no load semantics.** Activation is service-availability
 *   driven, which is what `inject` is for: a consumer whose service is absent
 *   stays `pending` until it exists.
 *
 * A layer is a YAML array whose elements are `insert`, `patch`, or `remove`.
 *
 * ```yaml
 * - insert:
 *     - id: model
 *       name: ./src/plugins/model.ts
 *       config: { provider: deepseek }
 * - patch:
 *     - id: model
 *       config: { provider: plugboard }
 * - remove: [old-thing]
 * ```
 */

/** One configured plugin row, in the shape the Cordis loader consumes. */
export interface EntryRow {
  /** Stable identity, addressed by later layers. */
  readonly id?: string
  /** Module specifier, resolved against the profile's base URL. */
  readonly name: string
  /** Validated by the plugin's own schema when the row starts. */
  readonly config?: unknown
  /** Marks the row as a group whose config is a child entry list. */
  readonly group?: boolean
  /** Keeps the row and its descendants from starting. */
  readonly disabled?: boolean
  /** Required services, or intercept config for this row. */
  readonly inject?: readonly string[] | null
}

/** One layer of the composed tree. */
export interface Layer {
  /** Rows this layer adds. */
  readonly insert?: readonly EntryRow[]
  /** Rows this layer restates, matched by `id`. */
  readonly patch?: readonly (Partial<EntryRow> & { readonly id: string })[]
  /** Ids this layer stops. */
  readonly remove?: readonly string[]
}

/** Parse one YAML layer, or report the file rather than a bare parse error. */
export function parseLayer(text: string, from: string): readonly Layer[] {
  const value = yaml.load(text)
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${from}: expected a top-level array of patch layers`)
  for (const layer of value) {
    if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
      throw new Error(`${from}: every layer must be a mapping of insert, patch or remove`)
    }
    const keys = Object.keys(layer)
    for (const key of keys) {
      if (!['insert', 'patch', 'remove'].includes(key)) {
        throw new Error(`${from}: unknown layer key '${key}'; expected insert, patch or remove`)
      }
    }
  }
  return value as readonly Layer[]
}

/** Read and parse one layer file. */
export function readLayer(path: string): readonly Layer[] {
  const absolute = resolve(path)
  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new Error(`could not read the configuration layer ${absolute}: ${(error as Error).message}`)
  }
  return parseLayer(text, absolute)
}

/**
 * Compose layers into the row list a tree is built from.
 *
 * This is a pure function on purpose: the composition is the part worth
 * checking without starting anything, so a layer that addresses a row that does
 * not exist fails here, where the error names the layer, rather than inside the
 * loader where it would name an internal id.
 */
export function compose(layers: readonly (readonly Layer[])[]): readonly EntryRow[] {
  const rows: EntryRow[] = []
  const index = new Map<string, number>()

  layers.forEach((layer, layerNumber) => {
    for (const part of layer) {
      for (const row of part.insert ?? []) {
        if (!row || typeof row.name !== 'string') {
          throw new Error(`layer ${layerNumber}: every inserted row needs a name`)
        }
        if (row.id !== undefined && index.has(row.id)) {
          throw new Error(`layer ${layerNumber}: '${row.id}' is inserted twice; use patch to restate it`)
        }
        if (row.id !== undefined) index.set(row.id, rows.length)
        rows.push(row)
      }

      for (const edit of part.patch ?? []) {
        if (!edit || typeof edit.id !== 'string') {
          throw new Error(`layer ${layerNumber}: every patched row needs an id`)
        }
        const at = index.get(edit.id)
        if (at === undefined) {
          throw new Error(`layer ${layerNumber}: patch names '${edit.id}', which no earlier layer inserted`)
        }
        const current = rows[at]
        if (current === undefined) {
          throw new Error(`layer ${layerNumber}: patch names '${edit.id}', which no earlier layer inserted`)
        }
        const { id: _id, ...rest } = edit
        rows[at] = { ...current, ...rest }
      }

      for (const id of part.remove ?? []) {
        const at = index.get(id)
        if (at === undefined) {
          throw new Error(`layer ${layerNumber}: remove names '${id}', which no earlier layer inserted`)
        }
        const current = rows[at]
        if (current === undefined) {
          throw new Error(`layer ${layerNumber}: remove names '${id}', which no earlier layer inserted`)
        }
        rows[at] = { ...current, disabled: true }
      }
    }
  })

  return rows
}

/** True when a specifier is a path rather than a package name. */
export function isRelative(name: string): boolean {
  return name.startsWith('.') || name.startsWith('/')
}

/**
 * Resolve a row's specifier against the profile's base URL.
 *
 * The loader imports by specifier, so a relative path in a configuration file
 * means "relative to the configuration", which is what a reader of the file
 * expects and what `import.meta.url` in the loader cannot supply.
 */
export function resolveSpecifier(name: string, baseUrl: string): string {
  if (!isRelative(name)) return name
  return new URL(name, baseUrl).href
}
