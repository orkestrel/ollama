import type {
	ContextFormat,
	Message,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
	ProviderStreamOptions,
	ThinkSplitterInterface,
} from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { ToolCall, ToolDefinition } from '@orkestrel/tool'
import type { OllamaOptions, OllamaResponse, WireChatRequest } from './types.js'
import { createThinkSplitter, ProviderAbortError } from '@orkestrel/agent'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { Timeout } from '@orkestrel/timeout'
import {
	DEFAULT_KEEP_ALIVE,
	DEFAULT_OLLAMA_URL,
	DEFAULT_PROVIDER_TIMEOUT,
	MAX_ERROR_BODY_LENGTH,
} from './constants.js'
import { OllamaHTTPError } from './errors.js'
import {
	assembleResult,
	extractContent,
	extractThinking,
	extractTools,
	extractUsage,
	joinThinking,
	mapMessages,
} from './helpers.js'
import { parseBody } from './parsers.js'

/**
 * The local Ollama inference boundary — a {@link ProviderInterface} over Ollama's
 * `POST /api/chat`, both non-streaming (`generate`) and streaming NDJSON (`stream`).
 *
 * @remarks
 * - **Wire protocol.** Posts `{ model, messages, stream, keep_alive, think }` plus
 *   passthrough sampling `options` and mapped function `tools`. The `think` flag is
 *   CONFIGURABLE via {@link OllamaOptions.think} (default `false`). Non-stream parses
 *   one JSON body; stream consumes NDJSON (one JSON object per `\n`-terminated line) —
 *   deltas carry `message.content`, the final `done: true` line carries the token usage.
 * - **Think separation (H4).** The wire `think` flag is configurable
 *   ({@link OllamaOptions.think}, default `false`). With `think: true` a thinking model's
 *   daemon separates reasoning NATIVELY — returning it on the distinct `message.thinking`
 *   channel (read here via `extractThinking`) instead of inline in `message.content`. EITHER
 *   way the per-call {@link ThinkSplitterInterface} is the defensive guarantee: a daemon
 *   may ignore `think: false` for a thinking model and inline `<think>` tags, so every
 *   content delta routes through the splitter, only CLEAN content is yielded / assembled,
 *   and the separated reasoning (plus any daemon-side `message.thinking` deltas) lands on
 *   `ProviderResult.thinking`, never in the conversation.
 * - **Boundary narrowing (§14).** Every wire value arrives as `unknown` and is
 *   narrowed through guards (`isRecord` / `isString` / `isNumber`) — never `as`. A
 *   missing / malformed field degrades to a sensible default (empty content, no
 *   usage, `{}` arguments), never a throw.
 * - **Bounded.** Each call arms a {@link Timeout} for `OllamaOptions.timeout` and
 *   passes `AbortSignal.any([timeout.signal, signal])` to `fetch`, so the caller's
 *   signal AND the deadline both cancel the request. The timeout is always cleared —
 *   in `#fetch` if the request fails/aborts, otherwise in the consuming call's `finally`.
 * - **Abort recovers partial.** A `stream` cancelled mid-flight throws a
 *   `ProviderAbortError` carrying the partial result assembled so far; pairing the
 *   `TextDecoder({ stream: true })` with the {@link NDJSONParser} parser keeps multi-byte
 *   UTF-8 splits and partial lines honest.
 * - **Event-free.** A pure functional boundary — no Emitter, no events.
 * - **Transport seam.** {@link OllamaOptions.fetch} swaps the transport (default
 *   `globalThis.fetch`) and {@link OllamaOptions.headers} is a per-request, possibly
 *   async header injector merged over the base `Content-Type` — so a browser runtime
 *   can route through the developer's own server with an obfuscated bearer token,
 *   without this library ever handling a real API key. Both omitted ⇒ the global `fetch`
 *   and only a JSON content type.
 *   Orthogonal to the deadline: the hook is awaited inside `#fetch`'s try, so a hook
 *   rejection clears the armed timer like any other request failure.
 *
 * @example
 * ```ts
 * const provider = new OllamaProvider({ model: 'qwen3.5:2b-q4_K_M' })
 * const result = await provider.generate(messages, abort.signal)
 * ```
 */
export class OllamaProvider implements ProviderInterface {
	readonly id = crypto.randomUUID()
	readonly name = 'ollama'
	readonly #model: string
	readonly #url: string
	readonly #keepAlive: string | number
	readonly #timeout: number
	readonly #think: boolean
	readonly #options: Readonly<Record<string, unknown>> | undefined
	readonly #transport: typeof globalThis.fetch
	readonly #headers:
		| (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>)
		| undefined
	readonly #format: ContextFormat | undefined

	constructor(options: OllamaOptions) {
		this.#model = options.model
		this.#url = options.url ?? DEFAULT_OLLAMA_URL
		this.#keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE
		this.#timeout = options.timeout ?? DEFAULT_PROVIDER_TIMEOUT
		// The `/api/chat` `think` wire flag — DEFAULT `false`, so a non-thinking model needs no
		// configuration and answers immediately. A thinking model whose reasoning is DISPLAYED
		// separately sets `think: true`, and the daemon then returns it on the
		// `message.thinking` channel (`extractThinking`) rather than inline in `message.content`.
		this.#think = options.think ?? false
		this.#options = options.options
		// The transport seam (§21): a custom fetch (defaulting to the global, BOUND to its
		// `globalThis` receiver — invoking a bare reference through a field loses the `window`
		// receiver and browsers throw `Illegal invocation`; node's fetch is receiver-agnostic,
		// so only a browser runtime ever saw it) and a dynamic header injector — both omitted
		// by default, so the request goes out over the global fetch carrying only the JSON
		// content type. The injected transport is `#transport` (the request METHOD already
		// owns the `#fetch` name).
		this.#transport = options.fetch ?? globalThis.fetch.bind(globalThis)
		this.#headers = options.headers
		// The context-framing default (the provider-DEFAULT level of AgentContext's format
		// cascade) — EXPOSE-ONLY: read by the Agent via `build(this.#provider.format)` and
		// consumed by core's cascade, it NEVER enters `#body` / the `/api/chat` wire. It is
		// NOT Ollama's structured-output `format` wire param — that one IS sent in `#body`,
		// but only when a per-call `ProviderStreamOptions.schema` is supplied; the two
		// merely share a word. Omitted ⇒ undefined ⇒ core's built-in framing.
		this.#format = options.format
	}

	/**
	 * The provider's context-framing default — the PROVIDER-DEFAULT level of
	 * {@link import('@orkestrel/agent').AgentContextInterface.build}'s format cascade (it BEATS
	 * the managers' built-in framing, is BEATEN by a manager-options or per-item override).
	 * Satisfies the OPTIONAL {@link ProviderInterface.format} contract member: `undefined`
	 * when {@link OllamaOptions.format} was omitted (the framing-agnostic default ⇒ core's
	 * built-in framing applies unchanged), else the exact configured framing the Agent
	 * threads into `build()`.
	 *
	 * @remarks
	 * EXPOSE-ONLY — read by the Agent loop and consumed by core's cascade; it is NEVER sent
	 * on the `/api/chat` wire (it is absent from `#body` / the request). This is NOT Ollama's
	 * structured-output `format` wire parameter — that one IS sent in `#body`, but only when
	 * a per-call `ProviderStreamOptions.schema` is supplied; only the word collides.
	 *
	 * @returns The configured {@link ContextFormat}, or `undefined` when none
	 */
	get format(): ContextFormat | undefined {
		return this.#format
	}

	async generate(
		messages: readonly Message[],
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): Promise<ProviderResult> {
		const { response, timeout } = await this.#fetch(messages, false, signal, tools, options)
		try {
			const record = await parseBody(response)
			// The one-body call routes through the SAME splitter as the stream (the daemon may
			// ignore `think: false` — the splitter is the guarantee): the assembled content is
			// CLEAN (the splitter's authoritative `content`, which also covers the qwen3
			// template's IMPLICIT leading open), the separated spans + any wire-side
			// `message.thinking` land on `thinking`.
			const splitter = createThinkSplitter()
			splitter.split(extractContent(record))
			splitter.flush()
			const thinking = joinThinking(splitter, extractThinking(record))
			return assembleResult(splitter.content, thinking, extractTools(record), extractUsage(record))
		} finally {
			timeout.clear()
		}
	}

	async *stream(
		messages: readonly Message[],
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		const { response, timeout, combined } = await this.#fetch(
			messages,
			true,
			signal,
			tools,
			options,
		)
		const body = response.body
		if (body === null) {
			timeout.clear()
			throw new OllamaHTTPError('Ollama API error: no response body', 0)
		}
		const reader = body.getReader()
		const decoder = new TextDecoder()
		const parser = createNDJSONParser()
		// The per-call think separator (H4): every wire content delta routes through it, so
		// only CLEAN content is yielded / assembled even when the daemon ignores `think: false`
		// for a thinking model; daemon-side `message.thinking` deltas accumulate beside it.
		// The ASSEMBLED content is the splitter's authoritative `content` — across the qwen3
		// template's IMPLICIT leading open (a bare `</think>` with the open pre-seeded into the
		// prompt scaffold) the splitter RECLASSIFIES the already-yielded prefix into `thinking`,
		// so the result stays clean even though those deltas could not be recalled.
		const splitter = createThinkSplitter()
		// The per-stream accumulators, folded from every `#deltas` return across the live
		// loop and the post-loop NDJSON tail flush below.
		let wired = ''
		const calls: ToolCall[] = []
		let usage: TokenUsage | undefined
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				// Pair the streaming decoder with the line parser: the decoder handles
				// partial multi-byte CHARS, the parser handles partial LINES (§14).
				for (const record of parser.parse(decoder.decode(value, { stream: true }))) {
					const increment = yield* this.#deltas(record, splitter, usage)
					wired += increment.thinking
					calls.push(...increment.calls)
					usage = increment.usage
				}
			}
			// Flush the decoder's held partial multi-byte tail and feed it (plus a
			// terminating `\n`) through the parser, so a non-conformant proxy's final
			// unterminated `done` line is recovered instead of silently dropped.
			const decoderTail = decoder.decode()
			for (const record of parser.parse(decoderTail.length > 0 ? `${decoderTail}\n` : '\n')) {
				const increment = yield* this.#deltas(record, splitter, usage)
				wired += increment.thinking
				calls.push(...increment.calls)
				usage = increment.usage
			}
			// Stream end: a held partial tag that never completed was real content — it is the
			// final delta (the splitter folds it into its `content` too).
			const tail = splitter.flush()
			if (tail.length > 0) yield { channel: 'content', text: tail }
		} catch (error) {
			// A mid-stream cancel (the caller's signal or the deadline) surfaces the
			// partial so the loop can recover what streamed; anything else propagates.
			if (combined.aborted) {
				// Flush the splitter's held partial tail first (mirrors the
				// normal-completion assembly above) so the recovered partial includes
				// any clean content that never crossed a tag boundary.
				splitter.flush()
				throw new ProviderAbortError(
					assembleResult(splitter.content, joinThinking(splitter, wired), calls, usage),
				)
			}
			throw error
		} finally {
			// Cancel (not merely release) the reader on early return so the
			// underlying HTTP connection is freed; a normal-done or already-errored
			// reader tolerates the redundant cancel as a no-op. `cancel()` also
			// releases the lock — never call `releaseLock()` afterward.
			try {
				await reader.cancel()
			} catch {
				// Never mask the primary error/result with a cancel failure.
			}
			parser.clear()
			timeout.clear()
		}
		return assembleResult(splitter.content, joinThinking(splitter, wired), calls, usage)
	}

	// Per-record streaming step shared between the live NDJSON loop and the post-loop
	// tail flush in `stream()` — a `#` private method (not a free helper) because it is
	// the streaming spine that composes the wire leaves and drives the splitter, and
	// because its yields are the stream's own. It mutates nothing: it RETURNS the record's
	// increments (`thinking` / `calls` / `usage`) and `stream()` folds them, so the
	// accumulator's shape is written once, here.
	*#deltas(
		record: Readonly<Record<string, unknown>>,
		splitter: ThinkSplitterInterface,
		usage: TokenUsage | undefined,
	): Generator<
		ProviderDelta,
		{
			readonly thinking: string
			readonly calls: readonly ToolCall[]
			readonly usage: TokenUsage | undefined
		}
	> {
		const delta = splitter.split(extractContent(record))
		if (delta.length > 0) yield { channel: 'content', text: delta }
		// The PRIMARY live reasoning channel: each native `message.thinking` wire delta is
		// surfaced as a tagged `thinking` delta AND returned for the caller's `wired`
		// accumulation (the two stay in lockstep). The ThinkSplitter's in-content
		// reclassified spans have no per-delta hook — the final `ProviderResult.thinking`
		// reconciles them; the native channel (think: true) is what streams live.
		const thinking = extractThinking(record)
		if (thinking.length > 0) yield { channel: 'thinking', text: thinking }
		// Only the `done` line carries usage, so every other record hands the caller's
		// current value straight back rather than clearing it.
		return {
			thinking,
			calls: extractTools(record),
			usage: Reflect.get(record, 'done') === true ? extractUsage(record) : usage,
		}
	}

	// Arm the deadline, POST `/api/chat`, and hand back the response + the handles
	// that bound it. On a non-OK status, clear the deadline and throw with the body.
	async #fetch(
		messages: readonly Message[],
		stream: boolean,
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): Promise<OllamaResponse> {
		const timeout = new Timeout({ ms: this.#timeout })
		timeout.start()
		const combined = AbortSignal.any([timeout.signal, signal])
		try {
			const response = await this.#transport(`${this.#url}/api/chat`, {
				method: 'POST',
				headers: await this.#requestHeaders(),
				body: JSON.stringify(this.#body(messages, stream, tools, options)),
				signal: combined,
			})
			if (!response.ok) {
				// Bound the incorporated body: a defensive proxy or daemon could hand
				// back an unbounded response — read defensively so a body-read
				// failure still throws with the status, never a masked/unbounded read.
				let detail: string
				try {
					const text = await response.text()
					detail = text.length > MAX_ERROR_BODY_LENGTH ? text.slice(0, MAX_ERROR_BODY_LENGTH) : text
				} catch (cause) {
					throw new OllamaHTTPError(
						`Ollama API error: ${response.status} - (error body unavailable)`,
						response.status,
						{ cause },
					)
				}
				throw new OllamaHTTPError(
					`Ollama API error: ${response.status} - ${detail}`,
					response.status,
				)
			}
			return { response, timeout, combined }
		} catch (error) {
			// `fetch` rejected (pre-aborted signal / unreachable / network) or the status
			// was non-OK — clear the deadline so the armed timer can't outlive the failed
			// call. The caller's `finally` only takes ownership once we return a response.
			timeout.clear()
			throw error
		}
	}

	// The request headers — the base JSON content type, plus the dynamic `headers`
	// hook's result merged ON TOP when configured (so a dev can attach an obfuscated
	// bearer the server validates). Merge order: `Content-Type` is seeded first, then
	// the hook's entries overlay it — so the hook ADDS auth headers but only clobbers
	// `Content-Type` if the dev explicitly returns one. Awaited (the hook may be async,
	// e.g. refreshing a token); called inside `#fetch`'s try so a hook rejection clears
	// the armed deadline like any other request failure. §14: the hook's result is a
	// `Readonly<Record<string, string>>` already — merged via `Object.entries`, no `as`.
	async #requestHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		if (this.#headers !== undefined) {
			for (const [key, value] of Object.entries(await this.#headers())) headers[key] = value
		}
		return headers
	}

	// The `/api/chat` request body — conditional `options` / `tools` / `format` only when set. The
	// wire `think` flag honours a PER-CALL override (`options.think`) over the constructor default
	// (`#think`), so a caller can flip reasoning on / off for one turn without reconfiguring the
	// provider; no per-call option ⇒ the constructed default.
	// `format` is the wire's structured-output constraint, forwarded verbatim from the per-call
	// `ProviderStreamOptions.schema` — unrelated to `OllamaOptions.format` (prompt-context framing).
	#body(
		messages: readonly Message[],
		stream: boolean,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): WireChatRequest {
		return {
			model: this.#model,
			messages: mapMessages(messages),
			stream,
			keep_alive: this.#keepAlive,
			think: options?.think ?? this.#think,
			...(this.#options !== undefined ? { options: this.#options } : {}),
			...(options?.schema !== undefined ? { format: options.schema } : {}),
			...(tools !== undefined && tools.length > 0
				? {
						tools: tools.map((tool): NonNullable<WireChatRequest['tools']>[number] => ({
							type: 'function',
							function: {
								name: tool.name,
								...(tool.description === undefined ? {} : { description: tool.description }),
								...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
							},
						})),
					}
				: {}),
		}
	}
}
