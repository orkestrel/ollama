import type {
	AgentResult,
	AgentStreamInterface,
	ContextFormatInterface,
	MessageInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
	ToolCall,
	ToolInterface,
	ToolResult,
} from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { TestRecorderInterface } from './setup.js'
import { createTool } from '@orkestrel/agent'
import { arrayOf, isRecord, isString } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createOllama, OllamaProvider } from '@src/server'

/**
 * Lowercase and flatten a fetch-standard `Headers` bag to single string values — the
 * shape transport / proxy tests assert on when recording proxied requests.
 */
export function flattenHeaders(headers: Headers): Readonly<Record<string, string>> {
	const result: Record<string, string> = {}
	headers.forEach((value, key) => {
		result[key.toLowerCase()] = value
	})
	return result
}

// Ollama-test setup — loaded after `setup.ts` for the node `src:server` project
// (the dedicated Ollama provider surface). The provider is tested against a REAL
// local Ollama (AGENTS §16: no mocks — only genuine third-party calls), so unlike
// the other projects this surface REQUIRES the daemon: there is no `skipIf`. This
// file enforces that requirement and WARMS the model before the suite runs, so a
// cold model load can't flake the live round-trips. Host / model are overridable so
// a different environment can point at its own Ollama.

// Read an environment variable by name, falling back when absent / empty / in a
// non-node runtime (kept defensive, though this file only runs in the node project).
export function env(name: string, fallback: string): string {
	if (typeof process === 'undefined') return fallback
	const value = process.env[name]
	return value !== undefined && value.length > 0 ? value : fallback
}

/**
 * Prefix a scheme-less `host:port` with `http://` — Ollama's own CLI/env convention
 * accepts a scheme-less value for `OLLAMA_HOST` (e.g. `127.0.0.1:11434`), but `fetch`
 * requires a full URL. A value that already starts with `http://` / `https://` passes
 * through unchanged.
 *
 * @param value - The host value to normalize, with or without a scheme
 * @returns `value` unchanged if it already has a scheme, otherwise `http://${value}`
 * @example
 * ```ts
 * withScheme('127.0.0.1:11434') // 'http://127.0.0.1:11434'
 * withScheme('https://ollama.example.com') // 'https://ollama.example.com'
 * ```
 */
export function withScheme(value: string): string {
	return value.startsWith('http://') || value.startsWith('https://') ? value : `http://${value}`
}

// The Ollama endpoint + model the provider tests hit — `OLLAMA_HOST` /
// `OLLAMA_MODEL` override the local defaults.
export const OLLAMA_CONFIG = {
	host: withScheme(env('OLLAMA_HOST', 'http://localhost:11434')),
	model: env('OLLAMA_MODEL', 'qwen3.5:2b-q4_K_M'),
} as const

// ── Live provider factories (the warmed-model test fixtures) ─────────────────
//
// AGENTS §16.1: the `createOllama({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host,
// options: { num_predict, temperature } })` builder every live test hand-rolls (the
// `provider()` / `createProvider()` locals in context / mcp / integration / OllamaProvider
// tests) folded into one factory — temperature 0 + a tight num_predict so each behavioral
// round-trip stays cheap on the resident model, with an optional context-framing `format`
// threaded natively (no wrapper). `createLiveOllama` returns the CONCRETE `OllamaProvider`
// for the tests that drive its `stream` / `generate` directly; `createLiveProvider` is the
// same provider as the `ProviderInterface` the agent layer consumes.

/** Tuning for a live Ollama test provider — all optional; see {@link createLiveProvider}. */
export interface LiveProviderOptions {
	/** The sampling cap, mapped to Ollama's `num_predict` (a small value keeps round-trips fast); defaults to `32`. */
	readonly predict?: number
	/** The sampling `temperature` (0 ⇒ greedy / reproducible); defaults to `0`. */
	readonly temperature?: number
	/** The provider's optional context-framing default (the provider-default cascade level). */
	readonly format?: ContextFormatInterface
}

/**
 * Build a live {@link OllamaProvider} against the warmed local model — the concrete-class
 * form for the tests that drive `stream` / `generate` directly (AGENTS §16.1). Points at
 * `OLLAMA_CONFIG`, defaults to a fast, reproducible `{ num_predict: 32, temperature: 0 }`
 * (each overridable), and threads an optional context-framing `format` natively.
 *
 * @param options - The {@link LiveProviderOptions} tuning (all optional)
 * @returns A concrete {@link OllamaProvider} over the warmed local model
 */
export function createLiveOllama(options?: LiveProviderOptions): OllamaProvider {
	return new OllamaProvider({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: options?.predict ?? 32, temperature: options?.temperature ?? 0 },
		format: options?.format,
	})
}

/**
 * Build a live Ollama {@link ProviderInterface} against the warmed local model — the shared
 * provider fixture for the live agent / context / mcp round-trips (AGENTS §16.1). The same
 * provider as {@link createLiveOllama}, surfaced as the `ProviderInterface` the agent layer
 * consumes (use {@link createLiveOllama} when a test needs the concrete class).
 *
 * @param options - The {@link LiveProviderOptions} tuning (all optional)
 * @returns A {@link ProviderInterface} over the warmed local model
 */
export function createLiveProvider(options?: LiveProviderOptions): ProviderInterface {
	return createLiveOllama(options)
}

/**
 * Build a summarizer function backed by a live warmed {@link OllamaProvider} — the shared
 * `ConversationManagerOptions['summarize']` fixture triplicated across the live compaction
 * tests (AGENTS §16.1). Frames the folded `messages` with a fixed one-sentence-digest
 * instruction as the FINAL user turn (a reasoning chat model reliably answers there, not
 * after a leading instruction), bounded by `timeoutMs`, and returns the generation's
 * `.content`.
 *
 * @param timeoutMs - The generation deadline in ms
 * @param predict - The `num_predict` cap for the summarizer's generation; defaults to `64`
 * @returns A `summarize` function over `readonly MessageInterface[]` returning the digest
 */
export function createLiveSummarizer(
	timeoutMs: number,
	predict = 64,
): (messages: readonly MessageInterface[]) => Promise<string> {
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: predict, temperature: 0 },
	})
	return async (messages) =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(timeoutMs),
			)
		).content
}

// Whether a local Ollama daemon answers `GET /api/tags` within 5s — the readiness
// gate. Total: any failure (connection refused, timeout, non-OK) resolves `false`,
// never throws.
export async function isOllamaAvailable(): Promise<boolean> {
	try {
		const response = await fetch(`${OLLAMA_CONFIG.host}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		})
		return response.ok
	} catch {
		return false
	}
}

// Hard readiness requirement + warmup, run once per Ollama test file before its
// suite. The `src:ollama` project REQUIRES Ollama, so an unreachable daemon throws a
// clear, actionable error rather than silently skipping. When reachable, a tiny
// `num_predict: 1` chat (think OFF, bounded by a generous deadline) loads the model
// into memory ahead of the real tests; `keep_alive` then keeps it resident across the
// serial test files so only the first file pays the cold-load cost.
const available = await isOllamaAvailable()
if (!available) {
	throw new Error(
		`Ollama is required for the src:ollama project — start the daemon at ${OLLAMA_CONFIG.host} and pull ${OLLAMA_CONFIG.model}`,
	)
}
await warmup()

// The file's one-shot module-load gate — invoked once by the top-level await above,
// deliberately not exported.
// Load the model into memory with a minimal generation. Bounded by a 60s deadline (a
// cold pull of a quantized model can take a while); any non-OK / network failure
// throws so a broken daemon surfaces loudly here rather than mid-test.
async function warmup(): Promise<void> {
	let response: Response
	try {
		response = await fetch(`${OLLAMA_CONFIG.host}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: OLLAMA_CONFIG.model,
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
				think: false,
				options: { num_predict: 1 },
				keep_alive: '30m',
			}),
			signal: AbortSignal.timeout(120_000),
		})
	} catch (error) {
		throw new Error(
			`Ollama warmup could not reach ${OLLAMA_CONFIG.host} for model ${OLLAMA_CONFIG.model} — a live Ollama daemon with the model pulled is required (${String(error)})`,
			{ cause: error },
		)
	}
	if (!response.ok) {
		throw new Error(
			`Ollama warmup failed (${response.status}) for model ${OLLAMA_CONFIG.model} at ${OLLAMA_CONFIG.host} — a live Ollama daemon with the model pulled is required`,
		)
	}
	// Drain the body so the connection is released before the suite starts.
	await response.text()
}

// ── Live request recipes (fixed `options` bags per behavioral category) ─────────
// AGENTS §16.1: one frozen recipe per test category, tuned against the live daemon
// measurements captured on qwen3.5:2b-q4_K_M @ CPU ~14 tok/s (see the dispatch's
// "Live daemon measurements" section) — the minimal `num_predict` that reliably
// exercises each behavior, kept deterministic with `temperature: 0`. `think` is a
// provider/per-call flag, never part of these option bags — callers set it directly.

/** Content / usage / thinking-off round-trips — warm ~1.4s at `num_predict: 8`. */
export const FAST_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

/** Multi-delta streaming round-trips (more than one NDJSON content line). */
export const STREAM_OPTIONS = Object.freeze({ num_predict: 16, temperature: 0 })

/** Tool-call turns — probe measured a 3/3 hit rate at this cap with `think: false`. */
export const TOOL_OPTIONS = Object.freeze({ num_predict: 32, temperature: 0 })

/** Mid-stream client abort + provider-deadline partial-response round-trips. */
export const ABORT_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

/** Determinism round-trips — `seed: 42` reproduced byte-identical content (2/2 probe runs). */
export const SEED_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0, seed: 42 })

/** Used WITH `think: true` — thinking drains the budget first, so content may be empty. */
export const THINK_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

// ── Recording proxy (real wire-shape assertions) ─────────────────────────────────
// A REAL pass-through HTTP server, built on `@orkestrel/server` + `@orkestrel/router`,
// that RECORDS every `POST /api/chat` it receives and forwards it VERBATIM to the real
// Ollama daemon, returning the daemon's real response (including a streamed body)
// UNALTERED. It never fabricates or mutates a response — the only thing it adds is
// observation, so tests can assert WHAT THE PROVIDER SENDS (context framing, headers,
// body shape) without depending on model behavior for that assertion. Centralized here
// per §16.1 (a node-only, Ollama-specific test helper); each test starts its own proxy
// and `close()`s it.

/** One recorded `POST /api/chat` request — its method, path, headers, and parsed JSON body. */
export interface RecordedRequest {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: Record<string, unknown>
}

/** A running recording proxy — its base `url`, the requests it `requests`, and `stop`. */
export interface RecordingProxyInterface {
	readonly url: string
	readonly requests: readonly RecordedRequest[]
	stop(): Promise<void>
}

/**
 * Parse a request body's raw text as JSON, coercing to a record. Invalid JSON and
 * valid-but-non-record JSON (an array, string, number, `null`, …) both yield
 * `undefined` — the capture is best-effort, never throwing.
 *
 * @param text - The raw request body text to parse
 * @returns The parsed record, or `undefined` if `text` isn't valid JSON or isn't a record
 * @example
 * ```ts
 * parseRequestBody('{"model":"qwen"}') // { model: 'qwen' }
 * parseRequestBody('[1,2]') // undefined
 * ```
 */
export function parseRequestBody(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text)
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/** One wire-protocol chat message narrowed from a {@link RecordedRequest.body} — role + content only. */
export interface WireMessage {
	readonly role: string
	readonly content: string
}

// Total guard for a single wire message: a record with string `role` + `content`.
const isWireMessage = (value: unknown): value is WireMessage =>
	isRecord(value) && isString(value.role) && isString(value.content)

// Total guard for the whole `messages` array on a recorded request body.
const isWireMessageArray = arrayOf(isWireMessage)

/**
 * Safely narrow a {@link RecordedRequest}'s `body.messages` to its wire-protocol shape,
 * without `as` casts — mirrors {@link parseRequestBody}'s guard-first approach. Absent or
 * malformed `messages` (missing, not an array, or any element lacking string `role` /
 * `content`) yields an empty array rather than throwing.
 *
 * @param request - The {@link RecordedRequest} whose body to narrow
 * @returns The request's wire messages, or `[]` when absent / malformed
 * @example
 * ```ts
 * wireMessages({ ...request, body: { messages: [{ role: 'user', content: 'hi' }] } })
 * // [{ role: 'user', content: 'hi' }]
 * ```
 */
export function wireMessages(request: RecordedRequest): readonly WireMessage[] {
	const { messages } = request.body
	return isWireMessageArray(messages) ? messages : []
}

/**
 * Join every {@link wireMessages} content with `'\n'` — the flat text a contains/not-contains
 * assertion runs against, without caring which turn carried which fragment.
 *
 * @param request - The {@link RecordedRequest} to extract wire text from
 * @returns Every wire message's `content`, joined by `'\n'`
 * @example
 * ```ts
 * wireText({ ...request, body: { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }] } })
 * // 'a\nb'
 * ```
 */
export function wireText(request: RecordedRequest): string {
	return wireMessages(request)
		.map((message) => message.content)
		.join('\n')
}

/**
 * The FIRST {@link wireMessages} entry's `content` when its role is `'system'`, else `''` —
 * for asserting context-order / section placement (a system prompt must lead the wire).
 *
 * @param request - The {@link RecordedRequest} to extract the leading system text from
 * @returns The first message's `content` when it is a `system` turn, else `''`
 * @example
 * ```ts
 * systemText({ ...request, body: { messages: [{ role: 'system', content: 'rules' }] } }) // 'rules'
 * systemText({ ...request, body: { messages: [{ role: 'user', content: 'hi' }] } }) // ''
 * ```
 */
export function systemText(request: RecordedRequest): string {
	const [first] = wireMessages(request)
	return first !== undefined && first.role === 'system' ? first.content : ''
}

/**
 * Clone a forwarded request's `Headers`, dropping `host` / `content-length` so `fetch`
 * recomputes them for the new upstream connection — every other header (including
 * `authorization`) passes through unchanged. Distinct from {@link flattenHeaders}:
 * `flattenHeaders` lowercases and flattens `Headers` into a plain record for
 * RECORDING / assertion, while this clones the `Headers` object itself (case
 * preserved) for upstream FORWARDING.
 *
 * @param headers - The inbound request's `Headers` to clone and filter
 * @returns A new `Headers` with `host` / `content-length` removed
 * @example
 * ```ts
 * forwardHeaders(new Headers({ host: 'localhost:11434', authorization: 'Bearer x' }))
 * // Headers without 'host', 'authorization' preserved
 * ```
 */
export function forwardHeaders(headers: Headers): Headers {
	const forwarded = new Headers(headers)
	forwarded.delete('host')
	forwarded.delete('content-length')
	return forwarded
}

/**
 * Narrow a fetch rejection to the raw `AbortSignal`-fired shape undici's `fetch`
 * rejects with (either the client's own disconnect or the proxy's own `stop()`).
 * Deliberately distinct from `isProviderAbortError` (`@orkestrel/agent`), which
 * narrows the provider-layer `ProviderAbortError` class — this guard operates one
 * layer lower, on the raw fetch/DOM abort rejection itself. `error is Error` is
 * complete for the default abort reason: DOMException subclasses `Error` in modern
 * Node, so `instanceof Error` catches the DOMException `'AbortError'` undici rejects
 * with, as well as historical plain-`Error` aborts.
 *
 * @param error - The unknown rejection value to narrow
 * @returns `true` if `error` is an `Error` named `'AbortError'`
 * @example
 * ```ts
 * isAbortError(AbortSignal.abort().reason) // true
 * isAbortError(new Error('boom')) // false
 * ```
 */
export function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === 'AbortError'
}

/**
 * Start a real pass-through recording proxy on an ephemeral port. Every `POST
 * /api/chat` is recorded, then forwarded VERBATIM to `upstream` — the daemon's real
 * response (status, headers, and streamed body) is returned UNALTERED. A client
 * abort (the request's own `signal`) propagates to the upstream fetch, and `stop()`
 * aborts any in-flight upstream request before tearing down the server — so neither
 * a client disconnect nor a proxy shutdown leaves an orphaned upstream generation
 * running.
 *
 * @param upstream - The real Ollama daemon base URL to forward to; defaults to {@link OLLAMA_CONFIG.host}
 * @returns The running {@link RecordingProxyInterface} — its `url`, the `requests`, and `stop`
 */
export async function createRecordingProxy(
	upstream: string = OLLAMA_CONFIG.host,
): Promise<RecordingProxyInterface> {
	const requests: RecordedRequest[] = []
	const upstreamAbort = new AbortController()
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({
		method: 'POST',
		path: '/api/chat',
		async handler(request) {
			const text = await request.text()
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				headers: flattenHeaders(request.headers),
				body: parseRequestBody(text) ?? {},
			})
			let upstreamResponse: Response
			try {
				upstreamResponse = await fetch(`${upstream}/api/chat`, {
					method: 'POST',
					headers: forwardHeaders(request.headers),
					body: text,
					signal: AbortSignal.any([request.signal, upstreamAbort.signal]),
				})
			} catch (error) {
				if (isAbortError(error)) return new Response(undefined, { status: 499 })
				throw error
			}
			return new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				headers: upstreamResponse.headers,
			})
		},
	})
	const server = createServer({ dispatcher, state: () => ({}) })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		get requests() {
			return requests
		},
		stop() {
			upstreamAbort.abort()
			return server.stop()
		},
	}
}

/**
 * Poll a {@link RecordingProxyInterface} until it has recorded at least `count`
 * requests, or throw once `timeoutMs` elapses — the "abort-once-recorded" pattern for
 * a wire-shape test that asserts ONLY on `proxy.requests` and never awaits the
 * provider call to completion (the response, and how long generation takes, are
 * irrelevant to those assertions).
 *
 * @param proxy - The {@link RecordingProxyInterface} to poll
 * @param count - The minimum number of recorded requests to wait for; defaults to `1`
 * @param timeoutMs - How long to poll before throwing; defaults to `10_000`
 * @returns Resolves once `proxy.requests.length >= count`
 */
export async function waitForRequest(
	proxy: RecordingProxyInterface,
	count = 1,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (proxy.requests.length < count) {
		if (Date.now() >= deadline) {
			throw new Error(
				`waitForRequest: expected ${count} recorded request(s), got ${proxy.requests.length} after ${timeoutMs}ms`,
			)
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

// ── Provider stream driver (Ollama-project test helper) ─────────────────────────
// Shared by the OllamaProvider and createOllama tests (AGENTS §16.1 — a helper used by
// more than one test file lives in a setup file). Drives the provider stream surface the
// live + stub round-trips exercise; node-only, so it lives here rather than the
// env-agnostic `setup.ts` (which owns the shared `createUserMessage` builder).

/**
 * Drive a provider `stream()` generator to completion — collecting the yielded deltas
 * and the RETURNED assembled {@link ProviderResult} (the union of the loop's two faces).
 *
 * @param generator - The `stream()` async generator to consume to completion
 * @returns The yielded `deltas` and the generator's returned `result`
 */
export async function drive(generator: AsyncGenerator<ProviderDelta, ProviderResult>): Promise<{
	readonly deltas: readonly string[]
	readonly thoughts: readonly string[]
	readonly result: ProviderResult
}> {
	const deltas: string[] = []
	const thoughts: string[] = []
	for (;;) {
		const step = await generator.next()
		if (step.done) return { deltas, thoughts, result: step.value }
		if (step.value.type === 'content') deltas.push(step.value.text)
		else thoughts.push(step.value.text)
	}
}

// ── Bounded-retry over small-model nondeterminism (Ollama-project helper) ────────
// AGENTS §16.1: the bounded-retry loop the live tests repeat (context.test.ts's
// `untilObeyed`, integration.test.ts's `untilRoundTrip`) folded into one generic helper. A
// warmed small model does not reliably satisfy a behavioral constraint on EVERY attempt, so
// a hard "must be right this run" assertion flakes; `retryUntil` runs `produce` up to
// `attempts` times, RETURNING the first value that SATISFIES the caller's genuine condition
// (for an unconditional re-assertion at the call site) and THROWING a clear, real-signal
// error tagged `description` only if NO attempt achieved it (a true failure — the model was
// never steered — never nondeterministic noise). Each attempt reuses the resident model
// (`keep_alive`), so retries stay cheap and the worst case fits the per-test timeout.

/** The default number of live attempts {@link retryUntil} makes before failing. */
export const ATTEMPTS = 6

/**
 * Retry `produce` up to `attempts` times, returning the first value that SATISFIES
 * `satisfied`; throw a clear error tagged `description` if none does (AGENTS §16.1).
 * Generalizes both live retry loops — `T` is the produced value (a generation's `string`
 * content, or a richer round-trip attempt record) and `satisfied` is the test's genuine
 * behavioral condition over it.
 *
 * @typeParam T - The value `produce` yields each attempt
 * @param produce - Runs one live attempt, resolving its value
 * @param satisfied - Whether an attempt's value meets the test's behavioral condition
 * @param description - What the model was meant to do (named in the failure message)
 * @param attempts - How many attempts to make before failing; defaults to {@link ATTEMPTS}
 * @returns The first value satisfying `satisfied`
 */
export async function retryUntil<T>(
	produce: () => Promise<T>,
	satisfied: (value: T) => boolean,
	description: string,
	attempts = ATTEMPTS,
): Promise<T> {
	let last: T | undefined
	for (let n = 0; n < attempts; n += 1) {
		const value = await produce()
		if (satisfied(value)) return value
		last = value
	}
	throw new Error(
		`model did not ${description} in ${attempts} attempts (final value: ${JSON.stringify(last)})`,
	)
}

// ── Agent stream driver (Ollama-project test helper) ─────────────────────────
// Mirrors `drive` (the provider-level `stream()` generator drainer above) one layer
// up: an agent's `stream()` returns an `AgentStreamInterface` — a pull `events`
// AsyncIterable of `AgentChunk`s plus a settling `result` — rather than a bare
// generator. AGENTS §16.1: shared by the sibling agent-loop test units.

/** A `tool` {@link AgentChunk}'s payload — the dispatched call paired with its result. */
export interface DrivenTool {
	readonly call: ToolCall
	readonly result: ToolResult
}

/**
 * Drive an {@link AgentStreamInterface} to completion — draining `events` into
 * type-bucketed arrays (`tokens` / `thoughts` / `tools` / `usages`) and awaiting the
 * settled {@link AgentResult}.
 *
 * @param stream - The `AgentStreamInterface` handle returned by an agent's `stream()`
 * @returns The bucketed chunks and the settled `result`
 */
export async function driveAgent(stream: AgentStreamInterface): Promise<{
	readonly tokens: readonly string[]
	readonly thoughts: readonly string[]
	readonly tools: readonly DrivenTool[]
	readonly usages: readonly TokenUsage[]
	readonly result: AgentResult
}> {
	const tokens: string[] = []
	const thoughts: string[] = []
	const tools: DrivenTool[] = []
	const usages: TokenUsage[] = []
	for await (const chunk of stream.events) {
		if (chunk.type === 'token') tokens.push(chunk.content)
		else if (chunk.type === 'think') thoughts.push(chunk.content)
		else if (chunk.type === 'tool') tools.push({ call: chunk.call, result: chunk.result })
		else usages.push(chunk.usage)
	}
	const result = await stream.result
	return { tokens, thoughts, tools, usages, result }
}

// ── Tool fixtures (Ollama-project test helper) ───────────────────────────────
// AGENTS §16.1: the two recurring agent-loop tool shapes — a deterministic lookup
// that returns a datum no model could produce by chance, and a tool that always
// throws — folded into one factory each, both accepting an optional recorder so a
// test can count executions without a mock.

/** The fixed, distinctive datum {@link createLookupTool} always returns. */
export const LOOKUP_DATUM = 'drizzle-42'

/**
 * Build a deterministic lookup tool — takes a single string `query` argument and
 * always returns {@link LOOKUP_DATUM}, a datum distinctive enough that its presence
 * in a model's answer proves the tool ran (AGENTS §16.1). An optional `recorder`
 * (from `createRecorder`) records each `execute` call's arguments.
 *
 * @param recorder - An optional {@link TestRecorderInterface} to record each call
 * @returns A working {@link ToolInterface} named `lookup`
 */
export function createLookupTool(
	recorder?: TestRecorderInterface<[Readonly<Record<string, unknown>>]>,
): ToolInterface {
	return createTool({
		name: 'lookup',
		description: 'Look up a fixed reference datum for a query string.',
		parameters: {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
		},
		execute: (args) => {
			recorder?.handler(args)
			return LOOKUP_DATUM
		},
	})
}

/** The message every {@link createThrowingTool} invocation throws. */
export const THROWING_TOOL_MESSAGE = 'throwing-tool-always-fails'

/**
 * Build a tool whose `execute` always throws {@link THROWING_TOOL_MESSAGE} — the
 * per-call error-isolation fixture (AGENTS §16.1). An optional `recorder` (from
 * `createRecorder`) records each `execute` call's arguments before it throws.
 *
 * @param recorder - An optional {@link TestRecorderInterface} to record each call
 * @returns A working {@link ToolInterface} named `fail` that always throws
 */
export function createThrowingTool(
	recorder?: TestRecorderInterface<[Readonly<Record<string, unknown>>]>,
): ToolInterface {
	return createTool({
		name: 'fail',
		description: 'A tool that always fails, for error-isolation round-trips.',
		parameters: { type: 'object', properties: {} },
		execute: (args) => {
			recorder?.handler(args)
			throw new Error(THROWING_TOOL_MESSAGE)
		},
	})
}

/**
 * Total chunks {@link createInsatiableTool} reports before completion — exceeds the DEFAULT
 * agent turn limit (10), so exhausting sustained tool pressure against this tool must hit the
 * limit before the chunk count completes.
 */
export const INSATIABLE_TOOL_CHUNKS = 12

/**
 * Build the result string {@link createInsatiableTool} returns for call `n` (1-based) —
 * reports concrete progress ("chunk n of {@link INSATIABLE_TOOL_CHUNKS}") plus an explicit
 * imperative to fetch the next chunk, giving the model a concrete unfinished plan to keep
 * following rather than a static "call again" instruction it may self-terminate against.
 *
 * @param n - The 1-based call number this result reports
 * @returns The progress-reporting result string for call `n`
 * @example
 * ```ts
 * insatiableResult(1)
 * // 'Chunk 1 of 12 received. The data is incomplete. You MUST call the more tool again now to get chunk 2.'
 * ```
 */
export function insatiableResult(n: number): string {
	return `Chunk ${n} of ${INSATIABLE_TOOL_CHUNKS} received. The data is incomplete. You MUST call the more tool again now to get chunk ${n + 1}.`
}

/**
 * Build a tool named `more` whose `execute` reports concrete counting progress via
 * {@link insatiableResult} — each call returns which chunk (of {@link INSATIABLE_TOOL_CHUNKS}
 * total) was just received and instructs the model to fetch the next one, for sustained
 * tool-call-pressure / limit-exhaustion round-trips (AGENTS §16.1). The counter is per-tool-
 * instance (1-based, incremented on every `execute`), so independent instances (e.g. one per
 * retry attempt) each start fresh at chunk 1. An optional `recorder` (from `createRecorder`)
 * records each `execute` call's arguments.
 *
 * @param recorder - An optional {@link TestRecorderInterface} to record each call
 * @returns A working {@link ToolInterface} named `more` reporting concrete chunk progress
 */
export function createInsatiableTool(
	recorder?: TestRecorderInterface<[Readonly<Record<string, unknown>>]>,
): ToolInterface {
	let n = 0
	return createTool({
		name: 'more',
		description:
			'Returns the next chunk of the requested data, reporting which chunk this is out of 12. Call again after every result until all chunks arrive.',
		parameters: {
			type: 'object',
			properties: { cursor: { type: 'string' } },
		},
		execute: (args) => {
			recorder?.handler(args)
			n += 1
			return insatiableResult(n)
		},
	})
}

// ── Tool-loop request recipe (Ollama-project test helper) ────────────────────

/** A 2-turn tool-call loop (model calls a tool, then answers) — a looser cap than {@link TOOL_OPTIONS}. */
export const TOOL_LOOP_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })
