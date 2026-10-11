import { ModelError, type Adapter, type Chunk, type GenerateRequest } from './types.ts'

/**
 * The two wire shapes this project speaks, plus the scripted one the checks use.
 *
 * Both HTTP adapters are thin on purpose. What varies between providers is the
 * request body, where a text delta lives in the event, and how the stream ends;
 * everything else — adding a tool call, counting tokens, one `done` chunk — is
 * the same and lives here once.
 */

/** One event parsed out of a `text/event-stream` body. */
interface SseEvent {
  readonly event?: string
  readonly data: string
}

/**
 * Parse an SSE body into events.
 *
 * Written against measured behaviour rather than the specification in one
 * place: the Codex route answers `200` with **no content type at all**, and
 * terminates with a `response.completed` event rather than `[DONE]`. So the
 * parse is driven by `data:` lines and never by a header.
 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    for (;;) {
      const split = buffer.indexOf('\n\n')
      if (split === -1) break
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const event = parseBlock(block)
      if (event) yield event
    }
  }
  const last = parseBlock(buffer)
  if (last) yield last
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') }
}

import { wire, type WireResponse } from './http.ts'

/** What a call site passes to {@link post}; the transport is in `./http.ts`. */
interface HttpOptions {
  readonly url: string
  readonly body: unknown
  readonly headers?: Record<string, string>
  readonly apiKey?: string
  readonly stream: boolean
  readonly timeoutMs?: number
  readonly endpoint: string
  readonly signal?: AbortSignal
}

/**
 * POST a request and hand back either parsed JSON or a streamed body.
 *
 * A non-2xx answer becomes a `ModelError` carrying the status and a short excerpt
 * of the body, because the failure that matters in practice is a gateway refusing
 * the call — `401` for a missing router credential, `403` for the Cloudflare gate,
 * `503` when the backend credential does not resolve — and each of those is
 * diagnosed from the status and the body, not from a stack trace.
 */
export function post(options: HttpOptions): Promise<WireResponse> {
  return wire({
    url: options.url,
    body: options.body,
    stream: options.stream,
    endpoint: options.endpoint,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
}

/** A tool call assembled from the fragments a streaming provider sends. */
export interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * OpenAI's Chat Completions shape.
 *
 * Chosen for the DeepSeek route, which speaks it natively and terminates with
 * `[DONE]`. Reasoning arrives as a `reasoning_content` delta, which is why the
 * chunk vocabulary has a `reasoning-delta` rather than flattening it into text.
 */
export function openAiChatAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  const body = {
    model: request.model ?? endpoint.model,
    messages: request.messages.map(toChatMessage),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
    ...(request.maxOutputTokens ?? endpoint.maxOutputTokens ?? undefined) !== undefined
      ? { max_tokens: request.maxOutputTokens ?? endpoint.maxOutputTokens }
      : {},
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }

  const streaming = endpoint.stream ?? request.stream ?? false

  return (async function* chat() {
    const result = await post({
      url: `${endpoint.baseUrl}/chat/completions`,
      body: { ...body, stream: streaming },
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
      ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      stream: streaming,
      endpoint: endpoint.name,
      ...(signal !== undefined ? { signal } : {}),
    })

    if ('json' in result) {
      yield* finishFromChatMessage(result.json)
      return
    }

    const calls = new Map<number, PartialToolCall>()
    for await (const event of readSse(result.stream)) {
      if (event.data === '[DONE]') break
      let parsed: {
        choices?: {
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          }
          finish_reason?: string | null
        }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      const choice = parsed.choices?.[0]
      const delta = choice?.delta
      if (delta?.reasoning_content) yield { type: 'reasoning-delta', text: delta.reasoning_content }
      if (delta?.content) yield { type: 'text-delta', text: delta.content }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (fragment.id) call.id = fragment.id
        if (fragment.function?.name) call.name = fragment.function.name
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments
        calls.set(index, call)
      }
      if (choice?.finish_reason) {
        for (const call of calls.values()) {
          yield { type: 'tool-call', id: call.id || `call-${call.name}`, name: call.name, arguments: call.arguments }
        }
        yield {
          type: 'done',
          finishReason: choice.finish_reason,
          ...(parsed.usage
            ? {
                usage: {
                  ...(parsed.usage.prompt_tokens !== undefined ? { inputTokens: parsed.usage.prompt_tokens } : {}),
                  ...(parsed.usage.completion_tokens !== undefined ? { outputTokens: parsed.usage.completion_tokens } : {}),
                },
              }
            : {}),
        }
        return
      }
    }
    yield { type: 'done', finishReason: 'stop' }
  })()
}

function toChatMessage(message: GenerateRequest['messages'][number]): Record<string, unknown> {
  const text = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
  const calls = message.content.filter((part) => part.type === 'tool-call')
  return {
    role: message.role,
    content: text.length > 0 ? text : null,
    ...(calls.length > 0
      ? {
          tool_calls: calls.map((part) => ({
            id: part.type === 'tool-call' ? part.id : '',
            type: 'function',
            function: { name: part.type === 'tool-call' ? part.name : '', arguments: part.type === 'tool-call' ? part.arguments : '' },
          })),
        }
      : {}),
    ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
  }
}

/** The non-streaming half of the chat shape, reduced to the same chunks. */
function* finishFromChatMessage(json: unknown): Generator<Chunk> {
  const answer = json as {
    choices?: { message?: { content?: string; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const choice = answer.choices?.[0]
  if (choice?.message?.reasoning_content) yield { type: 'reasoning-delta', text: choice.message.reasoning_content }
  if (choice?.message?.content) yield { type: 'text-delta', text: choice.message.content }
  for (const call of choice?.message?.tool_calls ?? []) {
    yield { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments }
  }
  yield {
    type: 'done',
    finishReason: choice?.finish_reason ?? 'stop',
    ...(answer.usage
      ? {
          usage: {
            ...(answer.usage.prompt_tokens !== undefined ? { inputTokens: answer.usage.prompt_tokens } : {}),
            ...(answer.usage.completion_tokens !== undefined ? { outputTokens: answer.usage.completion_tokens } : {}),
          },
        }
      : {}),
  }
}

/**
 * OpenAI's Responses shape, which is the only one the Codex route offers.
 *
 * Two measured contracts are enforced here rather than left to the caller:
 * `input` must be a **list**, and `stream` must be **true** — a `false` is
 * rejected with `400 Stream must be set to true`. The stream ends on a
 * `response.completed` event and there is no `[DONE]` sentinel, so the loop
 * watches for that name.
 */
export function openAiResponsesAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  const body = {
    model: request.model ?? endpoint.model,
    input: request.messages.map((message) => ({
      role: message.role === 'system' ? 'developer' : message.role,
      content: message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? { type: 'input_text', text: part.text } : part)),
    })),
    store: false,
    stream: true,
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
    ...(request.maxOutputTokens ?? endpoint.maxOutputTokens ?? undefined) !== undefined
      ? { max_output_tokens: request.maxOutputTokens ?? endpoint.maxOutputTokens }
      : {},
  }

  return (async function* responses() {
    const result = await post({
      url: `${endpoint.baseUrl}/responses`,
      body,
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
      ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      stream: true,
      endpoint: endpoint.name,
      ...(signal !== undefined ? { signal } : {}),
    })
    if ('json' in result) {
      throw new ModelError(`'${endpoint.name}' answered the Responses route without a stream`, {
        endpoint: endpoint.name,
        code: 'BAD_BODY',
      })
    }

    const calls = new Map<string, PartialToolCall>()
    let usage: { inputTokens?: number; outputTokens?: number } | undefined
    let finishReason = 'stop'

    for await (const event of readSse(result.stream)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      const type = String(parsed.type ?? event.event ?? '')
      if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        yield { type: 'text-delta', text: parsed.delta }
      } else if (type === 'response.reasoning_summary_text.delta' && typeof parsed.delta === 'string') {
        yield { type: 'reasoning-delta', text: parsed.delta }
      } else if (type === 'response.output_item.added') {
        const item = parsed.item as { type?: string; id?: string; name?: string; call_id?: string } | undefined
        if (item?.type === 'function_call') {
          calls.set(item.call_id ?? item.id ?? item.name ?? 'call', {
            id: item.call_id ?? item.id ?? 'call',
            name: item.name ?? '',
            arguments: '',
          })
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const key = String(parsed.item_id ?? parsed.call_id ?? 'call')
        const call = calls.get(key) ?? { id: key, name: '', arguments: '' }
        call.arguments += String(parsed.delta ?? '')
        calls.set(key, call)
      } else if (type === 'response.completed') {
        const response = parsed.response as
          | { usage?: { input_tokens?: number; output_tokens?: number }; status?: string }
          | undefined
        if (response?.usage) {
          usage = {
            ...(response.usage.input_tokens !== undefined ? { inputTokens: response.usage.input_tokens } : {}),
            ...(response.usage.output_tokens !== undefined ? { outputTokens: response.usage.output_tokens } : {}),
          }
        }
        finishReason = response?.status ?? 'stop'
        for (const call of calls.values()) {
          yield { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
        }
        yield { type: 'done', finishReason, ...(usage ? { usage } : {}) }
        return
      } else if (type === 'response.failed' || type === 'error') {
        throw new ModelError(`'${endpoint.name}' reported a failed response — ${JSON.stringify(parsed).slice(0, 300)}`, {
          endpoint: endpoint.name,
          code: 'REMOTE',
        })
      }
    }
    for (const call of calls.values()) {
      yield { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
    }
    yield { type: 'done', finishReason, ...(usage ? { usage } : {}) }
  })()
}

/**
 * A deterministic backend for the checks, and the reason they spend nothing.
 *
 * The endpoint's `baseUrl` names a JSON file holding the script: an array of
 * steps, each either text or a tool call. It reads no clock and calls nothing, so
 * a check that runs against it is reproducible and offline by construction.
 */
export function scriptedAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  return (async function* scripted() {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    // `~` is expanded here because a script path is written in a config file the
    // same way every other local path is, and a literal `~` directory does not
    // exist. Measured: this is what "the script could not be read at
    // ~/.heddle/scripted.json" meant the first time it ran.
    const scriptPath = endpoint.baseUrl.startsWith('~')
      ? `${homedir()}${endpoint.baseUrl.slice(1)}`
      : endpoint.baseUrl
    let script: { steps?: unknown[] } = {}
    try {
      script = JSON.parse(readFileSync(scriptPath, 'utf8')) as { steps?: unknown[] }
    } catch (error) {
      throw new ModelError(`the script for '${endpoint.name}' could not be read at ${scriptPath}`, {
        endpoint: endpoint.name,
        code: 'SCRIPT',
        cause: error,
      })
    }
    if (signal?.aborted) throw new ModelError('aborted', { endpoint: endpoint.name, code: 'ABORTED' })

    for (const step of script.steps ?? []) {
      const value = step as {
        text?: string
        reasoning?: string
        toolCall?: { name: string; arguments: unknown }
        finishReason?: string
      }
      if (value.reasoning) yield { type: 'reasoning-delta', text: value.reasoning }
      if (value.text) yield { type: 'text-delta', text: value.text }
      if (value.toolCall) {
        yield {
          type: 'tool-call',
          id: `call-${value.toolCall.name}`,
          name: value.toolCall.name,
          arguments: JSON.stringify(value.toolCall.arguments ?? {}),
        }
      }
    }
    yield { type: 'done', finishReason: 'stop' }
  })()
}

/** The adapter for one endpoint's declared kind. */
export function adapterFor(endpoint: Adapter['endpoint']): Adapter {
  switch (endpoint.kind) {
    case 'openai-chat':
      return { endpoint, stream: (request, signal) => openAiChatAdapter(endpoint, request, signal) }
    case 'openai-responses':
      return { endpoint, stream: (request, signal) => openAiResponsesAdapter(endpoint, request, signal) }
    case 'scripted':
      return { endpoint, stream: (request, signal) => scriptedAdapter(endpoint, request, signal) }
    default: {
      const kind: never = endpoint.kind
      throw new ModelError(`unknown endpoint kind '${String(kind)}'`, {
        endpoint: endpoint.name,
        code: 'UNKNOWN_KIND',
      })
    }
  }
}
