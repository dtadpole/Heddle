import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { describeEndpoint, resolveEndpoints } from '../endpoints.ts'
import { readLocalConfig } from '../local-config.ts'
import { ModelService } from '../llm/service.ts'
import type { EndpointConfig } from '../llm/types.ts'

export const name = 'model'

/**
 * One endpoint's configuration.
 *
 * Only `name` is required, because an endpoint restating a default may carry just
 * the field it changes. Validation runs before the body, so a typo in a layer
 * fails the load and names the field rather than surfacing later as `undefined`
 * inside a URL.
 */
const endpointSchema = Schema.object({
  name: Schema.string().required(),
  kind: Schema.union([
    Schema.const('openai-chat' as const),
    Schema.const('openai-responses' as const),
    Schema.const('scripted' as const),
  ]),
  baseUrl: Schema.string(),
  model: Schema.string(),
  apiKey: Schema.string(),
  apiKeyFile: Schema.string(),
  headers: Schema.dict(Schema.string()),
  stream: Schema.boolean(),
  maxOutputTokens: Schema.number(),
  capabilities: Schema.array(Schema.string()),
  timeoutMs: Schema.number(),
})

export const Config = Schema.object({
  /**
   * Endpoints this layer declares or restates.
   *
   * Empty in the repository's own layers on purpose: the values belong to the
   * machine, and `~/.heddle/heddle.json` exists for them.
   */
  endpoints: Schema.array(endpointSchema).default([]),
  /** The endpoint a caller means when it does not name one. */
  default: Schema.string(),
  /** Read the local file even when the layer named endpoints; off only in tests. */
  readLocalConfig: Schema.boolean().default(true),
})

export interface Config {
  readonly endpoints?: readonly Partial<EndpointConfig>[]
  readonly default?: string
  readonly readLocalConfig?: boolean
}

/**
 * The model plugin: one service, and no knowledge of any wire shape.
 *
 * Which backends exist is configuration, each wire shape is an adapter's
 * business, and a machine's URLs and credentials live outside the checkout.
 * That separation is the point of the plugin being this small.
 */
export default function model(ctx: Context, config: Config = {}): void {
  const local = config.readLocalConfig === false ? null : readLocalConfig()
  const localEndpoints = (local?.config.endpoints ?? []) as readonly Partial<EndpointConfig>[]
  const endpoints = resolveEndpoints(config.endpoints ?? [], localEndpoints)

  const service = new ModelService(ctx, endpoints)
  ctx.set('model', service)

  ctx.logger.info(
    'model: %d endpoint(s) — %s',
    endpoints.length,
    endpoints
      .map(describeEndpoint)
      .map((entry) => `${String(entry.name)}(${String(entry.kind)}${entry.credential ? ',credential' : ''})`)
      .join(', '),
  )
  ctx.logger.debug('model: local configuration %s', local === null ? 'absent, using defaults' : `read from ${local.path}`)
  const fallback = config.default ?? local?.config.default
  if (typeof fallback === 'string') ctx.logger.debug('model: default endpoint is %s', fallback)
}
