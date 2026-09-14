import type { ProviderOptions } from '@orkestrel/agent'

/**
 * Represents the exact `POST /api/chat` request body `OllamaProvider` sends — the internal typed
 * wire contract.
 *
 * @remarks
 * This is the typed wire shape asserted against the official `ollama` client's
 * `ChatRequest` by the compile-time parity test; `src/` never imports `ollama` itself.
 * `messages` mirrors the minimal turn shape `mapMessages` builds (`role` / `content`, plus
 * `tool_calls` only on a turn that replays them and `images` only on a multimodal
 * turn); `options` and `tools` are only present when configured. `format` carries the
 * `/api/chat` structured-output constraint, forwarded verbatim from the per-call
 * `ProviderStreamOptions.schema` and absent when no schema is supplied.
 */
export interface WireChatRequest {
	readonly model: string
	readonly messages: ReadonlyArray<{
		readonly role: string
		readonly content: string
		readonly tool_calls?: ReadonlyArray<{
			readonly function: {
				readonly name: string
				readonly arguments: Readonly<Record<string, unknown>>
			}
		}>
		readonly images?: readonly string[]
	}>
	readonly stream: boolean
	readonly keep_alive: string | number
	readonly think: boolean
	readonly options?: Readonly<Record<string, unknown>>
	readonly tools?: ReadonlyArray<{
		readonly type: 'function'
		readonly function: {
			readonly name: string
			readonly description?: string
			readonly parameters?: Readonly<Record<string, unknown>>
		}
	}>
	/**
	 * Holds the `/api/chat` structured-output constraint — a JSON-Schema object forwarded
	 * verbatim from the per-call `ProviderStreamOptions.schema`. This is not
	 * `OllamaOptions.format` (the unrelated prompt-context framing); only present
	 * when a call supplies a `schema`.
	 */
	readonly format?: Readonly<Record<string, unknown>>
}

/**
 * Represents the configuration `createOllama` accepts for the local Ollama backend.
 *
 * @remarks
 * Only `model` is required. `url` defaults to the local daemon, `keepAlive` controls
 * how long the model stays resident after a call, `timeout` is the per-call deadline
 * in milliseconds, and `options` is a passthrough bag of sampling parameters
 * (`temperature`, `seed`, and `num_predict`) forwarded verbatim to the wire.
 *
 * The optional `fetch` + `headers` form a **transport seam**: by default the provider
 * talks straight to a local daemon over `globalThis.fetch` with only a JSON content
 * type, but a browser-side runtime can inject both a custom transport and a dynamic header
 * (for example an obfuscated bearer token) so requests route through the developer's own
 * server, which validates that header and forwards to the real LLM. Your app never
 * holds a real API key — the real key lives only on the developer's server; the
 * `headers` hook supplies whatever short-lived/obfuscated token that server expects.
 */
export interface OllamaOptions extends ProviderOptions {
	readonly model: string
	/** Sets the daemon base URL; defaults to `'http://localhost:11434'`. */
	readonly url?: string
	/**
	 * Sets how long the model stays resident after a call; defaults to `'5m'`. Mirrors the
	 * Ollama `/api/chat` `keep_alive` field, whose value this key carries verbatim onto
	 * {@link WireChatRequest.keep_alive}.
	 */
	readonly keepAlive?: string | number
	/**
	 * Carries passthrough sampling parameters (`temperature`, `seed`, and `num_predict`).
	 * Mirrors the Ollama `/api/chat` `options` field, whose value this key carries verbatim
	 * onto {@link WireChatRequest.options}.
	 */
	readonly options?: Readonly<Record<string, unknown>>
	/**
	 * Sets the `/api/chat` `think` wire flag; defaults to `false`. When `true`, a thinking-capable
	 * model (for example `qwen3`) separates its reasoning natively at the wire — the daemon returns it
	 * on the distinct `message.thinking` channel (surfaced on `ProviderResult.thinking`) rather
	 * than inline in `message.content`. The default is `false`, so a non-thinking model needs no
	 * configuration and answers immediately; the per-call ThinkSplitter
	 * remains the defensive fallback for daemons/models that still inline `<think>` tags either
	 * way. Set it `true` for a thinking model whose reasoning you intend to display separately.
	 */
	readonly think?: boolean
}
