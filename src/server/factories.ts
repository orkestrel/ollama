import type { ProviderInterface } from '@orkestrel/agent'
import type { OllamaOptions } from './types.js'
import { OllamaProvider } from './OllamaProvider.js'

/**
 * Creates a local Ollama inference provider — a {@link ProviderInterface} over the
 * daemon's `POST /api/chat`, supporting non-streaming `generate` and streaming
 * `stream`.
 *
 * @remarks
 * Only `model` is required; `url` defaults to the local daemon, `keepAlive` to `'5m'`,
 * `timeout` to `120_000`ms, and `options` is forwarded verbatim as sampling
 * parameters (`temperature`, `seed`, and `num_predict`). Both calls take an
 * `AbortSignal` to bound the request; a `stream` cancelled mid-flight throws a
 * `ProviderAbortError` carrying the partial result.
 *
 * The optional `fetch` + `headers` form a transport seam (see {@link OllamaOptions}):
 * point `url` at your own server, inject a custom `fetch`, and have `headers` attach a
 * generated/obfuscated bearer token your server validates — so a browser runtime
 * reaches the LLM through your middleware WITHOUT this library ever handling the real API
 * key. Both omitted ⇒ the global `fetch` and only a JSON content type.
 *
 * The optional `format` is the provider's context-framing default — the PROVIDER-DEFAULT
 * level of `AgentContext`'s format cascade (beaten by a manager-options or per-item
 * override, beating the managers' built-in framing), declaring how this
 * provider's models prefer context sections framed (for example XML group wrappers vs. Markdown
 * headers). It is EXPOSED on the provider for the Agent's `build()` and is NOT Ollama's
 * `/api/chat` `format` wire parameter (structured output) — the two are unrelated despite
 * the shared word. Omitted ⇒ the provider is framing-agnostic (core's built-in defaults).
 *
 * @param options - `model` (required), and optional `url` / `keepAlive` / `timeout` /
 *   `options` / `fetch` / `headers` / `format` (see {@link OllamaOptions})
 * @returns A working {@link ProviderInterface} backed by Ollama
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { createOllama } from '@orkestrel/ollama'
 *
 * const provider = createOllama({ model: 'qwen3.5:2b-q4_K_M' })
 * const abort = createAbort()
 * const result = await provider.generate(messages, abort.signal)
 * ```
 *
 * @example
 * Route through your own server with an obfuscated token:
 * ```ts
 * const provider = createOllama({
 *   model: 'qwen3.5:2b-q4_K_M',
 *   url: 'https://my-app.example.com/llm', // your server, not the daemon
 *   fetch: myFetch, // optional custom transport
 *   headers: () => ({ authorization: `Bearer ${myToken}` }), // your server validates this
 * })
 * ```
 *
 * @example
 * Declare a context-framing default — wrap the instructions section in an XML group (the
 * provider-default level of `AgentContext`'s cascade; NOT the wire `format`):
 * ```ts
 * const provider = createOllama({
 *   model: 'qwen3.5:2b-q4_K_M',
 *   format: {
 *     instructions: {
 *       open: '<instructions>',
 *       render: (i) => `<instruction>${i.content}</instruction>`,
 *       close: '</instructions>',
 *     },
 *   },
 * })
 * ```
 */
export function createOllama(options: OllamaOptions): ProviderInterface {
	return new OllamaProvider(options)
}
