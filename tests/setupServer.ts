import type {
	ContextFormatInterface,
	MessageInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
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

// Ollama's own CLI/env convention accepts a scheme-less `host:port` for `OLLAMA_HOST`
// (e.g. `127.0.0.1:11434`); `fetch` requires a full URL, so a value that doesn't
// already start with `http://` / `https://` is prefixed with `http://` here.
function withScheme(value: string): string {
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

// Parse a request body's raw text as JSON, defensively narrowing to a record — an
// unparseable / non-object body yields `{}` (the capture is best-effort, never throwing).
function parseRequestBody(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text)
		return isRecord(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

// Clone a forwarded request's headers, dropping `host` / `content-length` so `fetch`
// recomputes them for the new upstream connection — every other header (including
// `authorization`) passes through unchanged.
function forwardedHeaders(headers: Headers): Headers {
	const forwarded = new Headers(headers)
	forwarded.delete('host')
	forwarded.delete('content-length')
	return forwarded
}

/**
 * Start a real pass-through recording proxy on an ephemeral port. Every `POST
 * /api/chat` is recorded, then forwarded VERBATIM to `upstream` — the daemon's real
 * response (status, headers, and streamed body) is returned UNALTERED.
 *
 * @param upstream - The real Ollama daemon base URL to forward to; defaults to {@link OLLAMA_CONFIG.host}
 * @returns The running {@link RecordingProxyInterface} — its `url`, the `requests`, and `stop`
 */
export async function createRecordingProxy(
	upstream: string = OLLAMA_CONFIG.host,
): Promise<RecordingProxyInterface> {
	const requests: RecordedRequest[] = []
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
				body: parseRequestBody(text),
			})
			const upstreamResponse = await fetch(`${upstream}/api/chat`, {
				method: 'POST',
				headers: forwardedHeaders(request.headers),
				body: text,
			})
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
