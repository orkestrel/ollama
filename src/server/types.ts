// The Ollama surface's public types. Imports from Orkestrel packages — agent for the
// provider contract, timeout for the per-call deadline interface.

import type { ContextFormat } from '@orkestrel/agent'
import type { TimeoutInterface } from '@orkestrel/timeout'

/**
 * Represents an open `POST /api/chat` response together with the deadline and the
 * combined signal that bound the request.
 *
 * @remarks
 * The `response` is the open `POST /api/chat` `Response`; `timeout` is the armed
 * {@link TimeoutInterface} the consuming call clears once it finishes reading the body
 * (or that the provider clears on a failed or aborted request); `combined` is the
 * `AbortSignal.any([timeout.signal, callerSignal])` the request was issued under, which
 * the streaming path checks to tell a mid-stream cancel apart from any other error.
 */
export interface OllamaResponse {
	readonly response: Response
	readonly timeout: TimeoutInterface
	readonly combined: AbortSignal
}

/**
 * Represents the exact `POST /api/chat` request body `OllamaProvider` sends — the internal typed
 * wire contract.
 *
 * @remarks
 * This is the typed wire shape asserted against the official `ollama` client's
 * `ChatRequest` by the compile-time parity test; `src/` never imports `ollama` itself.
 * `messages` mirrors the minimal turn shape `mapMessages` builds (`role` / `content`, plus
 * `tool_calls` only on a turn that replays them and `images` only on a multimodal
 * turn); `options` and `tools` are only present when configured.
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
	 * verbatim from the per-call `ProviderStreamOptions.schema`. This is NOT
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
 * type, but a browser-side runtime can inject a custom transport AND a dynamic header
 * (for example an obfuscated bearer token) so requests route through the developer's OWN
 * server, which validates that header and forwards to the real LLM. Your app never
 * holds a real API key — the real key lives only on the developer's server; the
 * `headers` hook supplies whatever short-lived/obfuscated token that server expects.
 */
export interface OllamaOptions {
	readonly model: string
	/** Sets the daemon base URL; defaults to `'http://localhost:11434'`. */
	readonly url?: string
	/**
	 * Sets how long the model stays resident after a call; defaults to `'5m'`. Mirrors the
	 * Ollama `/api/chat` `keep_alive` field, whose value this key carries verbatim onto
	 * {@link WireChatRequest.keep_alive}.
	 */
	readonly keepAlive?: string | number
	/** Sets the per-call deadline in milliseconds; defaults to `120_000`. */
	readonly timeout?: number
	/**
	 * Carries passthrough sampling parameters (`temperature`, `seed`, and `num_predict`).
	 * Mirrors the Ollama `/api/chat` `options` field, whose value this key carries verbatim
	 * onto {@link WireChatRequest.options}.
	 */
	readonly options?: Readonly<Record<string, unknown>>
	/**
	 * Sets the `/api/chat` `think` wire flag; defaults to `false`. When `true`, a thinking-capable
	 * model (for example `qwen3`) separates its reasoning NATIVELY at the wire — the daemon returns it
	 * on the distinct `message.thinking` channel (surfaced on `ProviderResult.thinking`) rather
	 * than inline in `message.content`. The default is `false`, so a non-thinking model needs no
	 * configuration and answers immediately; the per-call ThinkSplitter
	 * remains the defensive fallback for daemons/models that still inline `<think>` tags either
	 * way. Set it `true` for a thinking model whose reasoning you intend to DISPLAY separately.
	 */
	readonly think?: boolean
	/**
	 * Sets a custom `fetch` implementation for every request; defaults to
	 * `globalThis.fetch`. Lets a runtime inject its own transport (a browser fetch
	 * pointed at the developer's server, an instrumented wrapper) without changing
	 * the wire protocol. Omitted ⇒ the global `fetch`.
	 */
	readonly fetch?: typeof globalThis.fetch
	/**
	 * Sets a dynamic, possibly-async header injector called once per request; its returned
	 * headers are merged into the request on top of the base `Content-Type`. Use it to
	 * attach an authorization header — for example an obfuscated/generated bearer token the
	 * developer's server validates before relaying to the real LLM — so a browser
	 * runtime can authenticate WITHOUT your app ever handling a real API key. Async so a
	 * token can be refreshed/fetched per call. A returned `Content-Type` overrides the
	 * default; other headers add to it. Omitted ⇒ only `Content-Type: application/json`.
	 */
	readonly headers?: () =>
		| Readonly<Record<string, string>>
		| Promise<Readonly<Record<string, string>>>
	/**
	 * Sets the provider's OPTIONAL context-framing default — the PROVIDER-DEFAULT level of
	 * `AgentContext`'s format cascade (beaten by a manager-options or per-item override,
	 * beating the managers' built-in framing). Declares how this provider's models prefer
	 * context sections framed (for example XML group wrappers vs. Markdown headers). Omitted ⇒
	 * the provider is framing-agnostic and core's built-in defaults apply unchanged. NOTE:
	 * this is the prompt-CONTEXT framing consumed by `AgentContext.build()` — it is NOT
	 * Ollama's `/api/chat` `format` wire parameter (structured-output / JSON schema),
	 * which this provider sends only when a call supplies a `schema`; the two are unrelated
	 * despite the shared word.
	 */
	readonly format?: ContextFormat
}

/**
 * Represents the options a thrown {@link OllamaHTTPError} accepts beside its message and status —
 * the standard error `cause` link, named so a consumer can reference the shape.
 *
 * @remarks
 * `cause` is the underlying value that produced the HTTP failure: the transport or
 * body-read rejection the provider caught before rethrowing. It is `unknown` because a
 * thrown value is unconstrained. Omitted ⇒ the error carries no cause.
 */
export interface OllamaHTTPErrorOptions {
	readonly cause?: unknown
}
