import Schema from '@deepseek-ai/schemastery'

import { builtinTools } from '../tools/builtin.ts'
import { ToolRegistry } from '../tools/service.ts'

export const name = 'tools'

/**
 * The tools plugin, as a service class.
 *
 * It is a class rather than a function with an exported `inject` array because
 * the loader's own `inject` row is the mechanism that actually gates a plugin:
 * measured, a function that read `ctx.approvals` failed at load with "cannot get
 * property approvals without inject" while the loader reported no pending entry,
 * so the documented array was silently ignored. A service declares its
 * dependency where Cordis reads it.
 */
export default class ToolsPlugin extends ToolRegistry {
  static readonly Config = Schema.object({
    /** Tools to enable, by name. Empty means every registered tool. */
    allow: Schema.array(Schema.string()).default([]),
    /** Register the harness's own four tools. */
    includeBuiltins: Schema.boolean().default(true),
    /** Wall time a `bash` call may take before it is killed. */
    bashTimeoutMs: Schema.number().default(30_000),
  })

  static readonly inject = ['approvals', 'sandbox']

  constructor(ctx: import('@deepseek-ai/cordis').Context, config: { allow?: readonly string[]; includeBuiltins?: boolean; bashTimeoutMs?: number } = {}) {
    super(ctx, ctx.approvals, ctx.sandbox)

    const definitions = config.includeBuiltins === false ? [] : [...builtinTools(ctx.sandbox, { ...(config.bashTimeoutMs !== undefined ? { bashTimeoutMs: config.bashTimeoutMs } : {}) })]
    const allow = config.allow ?? []
    const selected = allow.length === 0 ? definitions : definitions.filter((tool) => allow.includes(tool.spec.name))
    for (const definition of selected) this.register(definition)

    const missing = allow.filter((tool) => !this.has(tool))
    if (missing.length > 0) {
      throw new Error(
        `the tools config names ${missing.join(', ')}, which this build does not register; registered: ${definitions.map((tool) => tool.spec.name).join(', ')}`,
      )
    }
    /**
     * One command, so the command path is a real path rather than an empty list.
     *
     * It shares the registry's two gates and its result shape with a tool, which
     * is the claim the tools part makes: a command is the same kind of thing with
     * a person at the other end.
     */
    this.registerCommand({
      name: 'describe',
      description: 'describe a tool by name — usage: describe <tool>',
      run: async (args) => {
        const wanted = args[0]
        if (wanted === undefined) {
          return { output: this.describe().map((tool) => `${tool.name}\t${tool.description}`).join('\n') }
        }
        const tool = this.describe().find((entry) => entry.name === wanted)
        if (tool === undefined) {
          return { output: '', error: { code: 'UNKNOWN_TOOL', message: `no tool named '${wanted}'` } }
        }
        return { output: `${tool.name}: ${tool.description}` }
      },
    })

    ctx.logger.info(
      'tools: %d registered, %d command(s) — %s',
      this.names().length,
      this.describeCommands().length,
      this.names().join(', '),
    )
  }
}
