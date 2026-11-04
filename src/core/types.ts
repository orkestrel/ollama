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
 * `ProviderStreamOptions.schema` and absent when no schema is supplied. `truncate` is a top-level
 * context switch on every body, and `shift` is one only when `OllamaOptions` sets it.
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
	 * verbatim from the per-call `ProviderStreamOptions.schema`. Only present when a call supplies a `schema`.
	 */
	readonly format?: Readonly<Record<string, unknown>>
	/**
	 * Holds the `/api/chat` top-level `truncate` switch, carried verbatim from
	 * {@link OllamaOptions.truncate} and `false` when the option is omitted, so the daemon refuses a
	 * prompt over the context window instead of cutting it.
	 */
	readonly truncate: boolean
	/**
	 * Holds the `/api/chat` top-level `shift` switch, carried verbatim from
	 * {@link OllamaOptions.shift} and absent when the option is omitted.
	 */
	readonly shift?: boolean
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
	/**
	 * Sets the `/api/chat` top-level `truncate` switch. Default: `false`. If `false`, the daemon
	 * answers a prompt over the context window with HTTP 400; if `true`, it drops the earlier turns,
	 * answers HTTP 200, and reports no cut. Carried verbatim onto {@link WireChatRequest.truncate},
	 * never inside `options`.
	 */
	readonly truncate?: boolean
	/**
	 * Sets the `/api/chat` top-level `shift` switch, sent only when set. Ollama 0.40.14 stops at the
	 * window with `done_reason: 'length'` whichever value is sent or none, and `shift: false` stops no
	 * prompt cut. Carried verbatim onto {@link WireChatRequest.shift}, never inside `options`.
	 */
	readonly shift?: boolean
}

/**
 * Configures the raw Mica judge wire, its calibration, and its transport.
 *
 * @remarks
 * `system` is the model's training prompt. `calibration.temperature` divides candidate
 * logprob gaps and must be finite and positive. Default: 1. `options` carries Ollama
 * sampling settings; the wire fixes `temperature` and `num_predict` to 1.
 */
export interface OllamaJudgeOptions extends Pick<ProviderOptions, 'timeout' | 'fetch' | 'headers'> {
	readonly model: string
	readonly system: string
	readonly calibration?: { readonly temperature: number }
	readonly url?: string
	/** Mirrors the Ollama `keep_alive` duration. Default: '5m'. */
	readonly keepAlive?: string | number
	readonly options?: Readonly<Record<string, unknown>>
	/**
	 * Sets the `/api/generate` `truncate` switch. Default: `false`. If `false`, the daemon answers a
	 * prompt over the context window with HTTP 400 and the call throws; if `true`, it cuts the prompt
	 * and reports no cut, and the judge's identity records the switch.
	 */
	readonly truncate?: boolean
}

/** Carries a token and its log probability from Ollama's top logprob list. */
export interface Logprob {
	readonly token: string
	readonly logprob: number
}

/**
 * Carries the daemon durations of one terminal record in raw nanoseconds.
 *
 * @remarks
 * Each member maps one wire field and keeps its integer verbatim, with no unit conversion:
 * `total` is `total_duration`, `load` is `load_duration`, `prompt` is `prompt_eval_duration`,
 * and `decode` is `eval_duration`. A member is `undefined` when the record omits its field or
 * carries an invalid value.
 */
export interface OllamaDurations {
	readonly total: number | undefined
	readonly load: number | undefined
	readonly prompt: number | undefined
	readonly decode: number | undefined
}

/**
 * Carries the token counts of one terminal record.
 *
 * @remarks
 * Each member maps one wire field: `prompt` is `prompt_eval_count`, `decode` is `eval_count`,
 * and `cached` is `prompt_eval_cached_count`. A member is `undefined` when the record omits its
 * field or carries an invalid value.
 */
export interface OllamaCounts {
	readonly prompt: number | undefined
	readonly decode: number | undefined
	readonly cached: number | undefined
}

/**
 * Carries the timing observation of one terminal record.
 *
 * @remarks
 * `invalid` lists the wire keys the record carried with a value that is not a non-negative safe
 * integer, in the order `total_duration`, `load_duration`, `prompt_eval_duration`,
 * `eval_duration`, `prompt_eval_count`, `eval_count`, `prompt_eval_cached_count`. An omitted
 * field is unknown, not invalid, and appears there never.
 */
export interface OllamaTiming {
	readonly durations: OllamaDurations
	readonly counts: OllamaCounts
	readonly invalid: readonly string[]
}

/** Transliterates the Ollama raw, non-streaming `POST /api/generate` request. */
export interface WireGenerateRequest {
	readonly model: string
	readonly prompt: string
	readonly raw: true
	readonly stream: false
	readonly logprobs: true
	readonly top_logprobs: number
	readonly keep_alive: string | number
	readonly options: Readonly<Record<string, unknown>>
	/** Holds the `/api/generate` `truncate` switch, `false` unless {@link OllamaJudgeOptions.truncate} sets it. */
	readonly truncate: boolean
}
