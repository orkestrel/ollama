import type {
	ContextFormatInterface,
	MessageInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
	ProviderStreamOptions,
	ThinkSplitterInterface,
	ToolCall,
	ToolDefinition,
} from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { OllamaOptions, OllamaResponse, WireChatRequest } from './types.js'
import { createThinkSplitter, ProviderAbortError } from '@orkestrel/agent'
import { isNumber, isRecord, isString } from '@orkestrel/contract'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { Timeout } from '@orkestrel/timeout'
import {
	DEFAULT_KEEP_ALIVE,
	DEFAULT_OLLAMA_URL,
	DEFAULT_PROVIDER_TIMEOUT,
	MAX_ERROR_BODY_LENGTH,
} from './constants.js'
import { OllamaHTTPError } from './errors.js'

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
 *   channel (read here via `#thinking`) instead of inline in `message.content`. EITHER
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
 *   without this library ever handling a real API key. Both omitted ⇒ today's behaviour.
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
	readonly #headers: (() => Record<string, string> | Promise<Record<string, string>>) | undefined
	readonly #format: ContextFormatInterface | undefined

	constructor(options: OllamaOptions) {
		this.#model = options.model
		this.#url = options.url ?? DEFAULT_OLLAMA_URL
		this.#keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE
		this.#timeout = options.timeout ?? DEFAULT_PROVIDER_TIMEOUT
		// The `/api/chat` `think` wire flag — DEFAULT `false` so the general-purpose provider
		// stays backward-compatible and immediate for non-thinking models. A thinking model whose
		// reasoning is DISPLAYED separately sets `think: true`, and the daemon then returns it on
		// the `message.thinking` channel (`#thinking`) rather than inline in `message.content`.
		this.#think = options.think ?? false
		this.#options = options.options
		// The transport seam (§21): a custom fetch (defaulting to the global, BOUND to its
		// `globalThis` receiver — invoking a bare reference through a field loses the `window`
		// receiver and browsers throw `Illegal invocation`; node's fetch is receiver-agnostic,
		// so only a browser runtime ever saw it) and a dynamic header injector — both omitted
		// by default, so today's behaviour is byte-identical (the global fetch, only the JSON
		// content type). The injected transport is `#transport` (the request METHOD already
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
	 * @returns The configured {@link ContextFormatInterface}, or `undefined` when none
	 */
	get format(): ContextFormatInterface | undefined {
		return this.#format
	}

	async generate(
		messages: readonly MessageInterface[],
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): Promise<ProviderResult> {
		const { response, timeout } = await this.#fetch(messages, false, signal, tools, options)
		try {
			const record = await this.#parseBody(response)
			// The one-body call routes through the SAME splitter as the stream (the daemon may
			// ignore `think: false` — the splitter is the guarantee): the assembled content is
			// CLEAN (the splitter's authoritative `content`, which also covers the qwen3
			// template's IMPLICIT leading open), the separated spans + any wire-side
			// `message.thinking` land on `thinking`.
			const splitter = createThinkSplitter()
			splitter.split(this.#content(record))
			splitter.flush()
			const thinking = this.#thought(splitter, this.#thinking(record))
			return this.#result(splitter.content, thinking, this.#tools(record), this.#usage(record))
		} finally {
			timeout.clear()
		}
	}

	async *stream(
		messages: readonly MessageInterface[],
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
		// Mutable per-stream accumulator shared between the live loop and the post-loop
		// NDJSON tail flush below — the SAME object reference threads through every
		// `#deltas` call so `wired` / `calls` / `usage` accumulate across both sites.
		const state: {
			splitter: ThinkSplitterInterface
			wired: string
			calls: ToolCall[]
			usage: TokenUsage | undefined
		} = {
			splitter,
			wired: '',
			calls: [],
			usage: undefined,
		}
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				// Pair the streaming decoder with the line parser: the decoder handles
				// partial multi-byte CHARS, the parser handles partial LINES (§14).
				for (const record of parser.parse(decoder.decode(value, { stream: true }))) {
					yield* this.#deltas(record, state)
				}
			}
			// Flush the decoder's held partial multi-byte tail and feed it (plus a
			// terminating `\n`) through the parser, so a non-conformant proxy's final
			// unterminated `done` line is recovered instead of silently dropped.
			const decoderTail = decoder.decode()
			for (const record of parser.parse(decoderTail.length > 0 ? `${decoderTail}\n` : '\n')) {
				yield* this.#deltas(record, state)
			}
			// Stream end: a held partial tag that never completed was real content — it is the
			// final delta (the splitter folds it into its `content` too).
			const tail = splitter.flush()
			if (tail.length > 0) yield { type: 'content', text: tail }
		} catch (error) {
			// A mid-stream cancel (the caller's signal or the deadline) surfaces the
			// partial so the loop can recover what streamed; anything else propagates.
			if (combined.aborted) {
				// Flush the splitter's held partial tail first (mirrors the
				// normal-completion assembly above) so the recovered partial includes
				// any clean content that never crossed a tag boundary.
				splitter.flush()
				throw new ProviderAbortError(
					this.#result(
						splitter.content,
						this.#thought(splitter, state.wired),
						state.calls,
						state.usage,
					),
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
			parser.reset()
			timeout.clear()
		}
		return this.#result(
			splitter.content,
			this.#thought(splitter, state.wired),
			state.calls,
			state.usage,
		)
	}

	// Per-record streaming step shared between the live NDJSON loop and the post-loop
	// tail flush in `stream()` — a `#` private method (not a free helper) because it
	// calls sibling methods (`this.#content` / `#thinking` / `#tools` / `#usage`) and
	// mutates the caller's `state` accumulator (`wired` / `calls` / `usage`) across
	// repeated calls sharing the same object reference.
	*#deltas(
		record: Record<string, unknown>,
		state: {
			splitter: ThinkSplitterInterface
			wired: string
			calls: ToolCall[]
			usage: TokenUsage | undefined
		},
	): Generator<ProviderDelta> {
		const delta = state.splitter.split(this.#content(record))
		if (delta.length > 0) yield { type: 'content', text: delta }
		// The PRIMARY live reasoning channel: each native `message.thinking` wire delta is
		// surfaced as a tagged `thinking` delta AND accumulated into `state.wired` for the
		// assembled result (the two stay in lockstep). The ThinkSplitter's in-content
		// reclassified spans have no per-delta hook — the final `ProviderResult.thinking`
		// reconciles them; the native channel (think: true) is what streams live.
		const thinking = this.#thinking(record)
		if (thinking.length > 0) yield { type: 'thinking', text: thinking }
		state.wired += thinking
		state.calls.push(...this.#tools(record))
		if (Reflect.get(record, 'done') === true) state.usage = this.#usage(record)
	}

	// Arm the deadline, POST `/api/chat`, and hand back the response + the handles
	// that bound it. On a non-OK status, clear the deadline and throw with the body.
	async #fetch(
		messages: readonly MessageInterface[],
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

	// The non-stream `/api/chat` body — read the 200-OK response as text and parse it
	// inside a total guard (§14): a malformed or empty body degrades to `{}` (empty
	// content, no usage), never a raw `SyntaxError` escaping to the caller.
	async #parseBody(response: Response): Promise<Record<string, unknown>> {
		const text = await response.text()
		if (text.length === 0) return {}
		try {
			const data: unknown = JSON.parse(text)
			return isRecord(data) ? data : {}
		} catch {
			return {}
		}
	}

	// The request headers — the base JSON content type, plus the dynamic `headers`
	// hook's result merged ON TOP when configured (so a dev can attach an obfuscated
	// bearer the server validates). Merge order: `Content-Type` is seeded first, then
	// the hook's entries overlay it — so the hook ADDS auth headers but only clobbers
	// `Content-Type` if the dev explicitly returns one. Awaited (the hook may be async,
	// e.g. refreshing a token); called inside `#fetch`'s try so a hook rejection clears
	// the armed deadline like any other request failure. §14: the hook's result is a
	// `Record<string, string>` already — merged via `Object.entries`, no `as`.
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
	// provider; no per-call option ⇒ the constructed default, byte-for-byte the prior behaviour.
	// `format` is the wire's structured-output constraint, forwarded verbatim from the per-call
	// `ProviderStreamOptions.schema` — unrelated to `OllamaOptions.format` (prompt-context framing).
	#body(
		messages: readonly MessageInterface[],
		stream: boolean,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): WireChatRequest {
		return {
			model: this.#model,
			messages: this.#plain(messages),
			stream,
			keep_alive: this.#keepAlive,
			think: options?.think ?? this.#think,
			...(this.#options !== undefined ? { options: this.#options } : {}),
			...(options?.schema !== undefined ? { format: options.schema } : {}),
			...(tools !== undefined && tools.length > 0
				? {
						tools: tools.map(
							(
								tool,
							): {
								type: 'function'
								function: {
									name: string
									description?: string
									parameters?: Readonly<Record<string, unknown>>
								}
							} => ({
								type: 'function',
								function: {
									name: tool.name,
									description: tool.description,
									parameters: tool.parameters,
								},
							}),
						),
					}
				: {}),
		}
	}

	// Map messages to the wire's minimal turn shape — `tool_calls` only on a turn
	// that replays them, `images` only on a multimodal turn (omit empty optionals).
	#plain(messages: readonly MessageInterface[]): WireChatRequest['messages'] {
		return messages.map((message) => ({
			role: message.role,
			content: message.content,
			...(message.calls !== undefined && message.calls.length > 0
				? {
						tool_calls: message.calls.map((call) => ({
							function: { name: call.name, arguments: call.arguments },
						})),
					}
				: {}),
			// Forward multimodal image data — Ollama accepts a base64 `images` array on a
			// message, which a vision-capable model receives alongside the text content.
			...(message.images !== undefined && message.images.length > 0
				? { images: [...message.images] }
				: {}),
		}))
	}

	// Assemble a ProviderResult including only the present optionals — no empty
	// `thinking` / `tools`, no `usage` unless the wire reported it.
	#result(
		content: string,
		thinking: string,
		tools: readonly ToolCall[],
		usage: TokenUsage | undefined,
	): ProviderResult {
		const result: {
			content: string
			thinking?: string
			tools?: readonly ToolCall[]
			usage?: TokenUsage
		} = { content }
		if (thinking.length > 0) result.thinking = thinking
		if (tools.length > 0) result.tools = tools
		if (usage !== undefined) result.usage = usage
		return result
	}

	// The assistant text of one wire record — `message.content` when a string, else
	// `''` (a delta line, a tool-only turn, or a malformed shape).
	#content(record: Record<string, unknown>): string {
		const message = Reflect.get(record, 'message')
		if (!isRecord(message)) return ''
		const content = Reflect.get(message, 'content')
		return isString(content) ? content : ''
	}

	// The daemon-side reasoning of one wire record — `message.thinking` when a string
	// (the `think: true` wire shape — surfaced when the configured `think` flag is on, and
	// handled defensively regardless since the daemon may vary), else `''`.
	#thinking(record: Record<string, unknown>): string {
		const message = Reflect.get(record, 'message')
		if (!isRecord(message)) return ''
		const thinking = Reflect.get(message, 'thinking')
		return isString(thinking) ? thinking : ''
	}

	// Join a call's two reasoning carriers — the splitter's separated in-content spans and
	// the accumulated wire-side `message.thinking` — blank-line separated when both exist.
	#thought(splitter: ThinkSplitterInterface, wired: string): string {
		if (splitter.thinking.length === 0) return wired
		if (wired.length === 0) return splitter.thinking
		return `${splitter.thinking}\n\n${wired}`
	}

	// Token usage from a wire record — only when BOTH counts are numbers (`done`
	// line / non-stream body); a delta line carries neither, so it yields undefined.
	#usage(record: Record<string, unknown>): TokenUsage | undefined {
		const prompt = Reflect.get(record, 'prompt_eval_count')
		const completion = Reflect.get(record, 'eval_count')
		if (!isNumber(prompt) || !isNumber(completion)) return undefined
		return { prompt, completion, total: prompt + completion }
	}

	// Tool calls from a wire record's `message.tool_calls` — each entry narrowed to
	// `{ id, name, arguments }`, minting an id when the wire omits one and coercing a
	// JSON-string `arguments` to a record (defaulting to `{}`); §14, no `as`.
	#tools(record: Record<string, unknown>): readonly ToolCall[] {
		const message = Reflect.get(record, 'message')
		if (!isRecord(message)) return []
		const calls = Reflect.get(message, 'tool_calls')
		if (!Array.isArray(calls)) return []
		const out: ToolCall[] = []
		for (const entry of calls) {
			if (!isRecord(entry)) continue
			const callable = Reflect.get(entry, 'function')
			if (!isRecord(callable)) continue
			const name = Reflect.get(callable, 'name')
			if (!isString(name)) continue
			const id = Reflect.get(entry, 'id')
			out.push({
				id: isString(id) ? id : crypto.randomUUID(),
				name,
				arguments: this.#arguments(Reflect.get(callable, 'arguments')),
			})
		}
		return out
	}

	// Narrow a wire `arguments` value to a record — an object as-is, a JSON string
	// parsed (when it yields a record), otherwise `{}`. Total: a bad string never throws.
	#arguments(value: unknown): Readonly<Record<string, unknown>> {
		if (isRecord(value)) return value
		if (isString(value)) {
			try {
				const parsed: unknown = JSON.parse(value)
				if (isRecord(parsed)) return parsed
			} catch {
				return {}
			}
		}
		return {}
	}
}
