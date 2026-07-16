import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
	ContextFormatInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import { createServer } from 'node:http'
import { isNumber, isRecord } from '@orkestrel/contract'
import { OllamaProvider } from '@src/server'

/**
 * Lowercase and flatten an `IncomingMessage` header bag to single string values — the
 * shape transport / stub tests assert on when recording proxied requests.
 */
export function flattenHeaders(
	headers: IncomingMessage['headers'],
): Readonly<Record<string, string>> {
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue
		result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
	}
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
	/** The `num_predict` sampling cap (a small value keeps round-trips fast); defaults to `32`. */
	readonly numPredict?: number
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
		options: { num_predict: options?.numPredict ?? 32, temperature: options?.temperature ?? 0 },
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

// ── Stub Ollama daemon (deterministic provider tests) ──────────────────────────
// A REAL local HTTP server that answers `POST /api/chat` with crafted responses —
// the deterministic counterpart to the live tests above (AGENTS §16: a genuine
// third-party HTTP round-trip over the real `fetch` + `TextDecoder` + `NDJSONParser` path,
// NOT a mock of the provider). It lets the OllamaProvider tests pin the behaviours a
// small quantized model can't make deterministic — the exact request wire shape, a
// non-OK status's error text, a malformed / empty / absent body, the §14 `arguments`
// narrowing (a JSON-string / id-less / garbage tool call), and the streaming decoder's
// multi-byte + partial-line reassembly (raw bytes split mid-character). Centralized
// here per §16.1 (a node-only, Ollama-specific test helper); each test starts its own
// server and `close()`s it.

/** How a {@link OllamaStub} should answer the next `POST /api/chat`. */
export interface StubBehavior {
	/** Respond with this HTTP status (defaults to `200`). A non-2xx exercises the error path. */
	readonly status?: number
	/** The non-streaming JSON body to send verbatim (used when `chunks` is absent). */
	readonly body?: unknown
	/** A raw string body sent as-is (for malformed-JSON / empty-body cases) — overrides `body`. */
	readonly raw?: string
	/**
	 * Send a `204 No Content` with NO body — `fetch` exposes this as `response.body ===
	 * null`, exercising the stream's "no response body" guard (a 200 with no written
	 * body yields a non-null stream that simply ends, a different case).
	 */
	readonly empty?: boolean
	/**
	 * Stream these raw byte chunks one-by-one (each flushed separately) instead of a
	 * single JSON body — for the NDJSON streaming path. Splitting a multi-byte UTF-8
	 * character or a `\n` across two chunks exercises the `TextDecoder` + `NDJSONParser` pair.
	 */
	readonly chunks?: readonly Uint8Array[]
	/**
	 * After streaming `chunks`, keep the connection open WITHOUT ending it — so the
	 * provider's own armed deadline is what trips the read. The test must use a tiny
	 * `timeout` to bound it.
	 */
	readonly hang?: boolean
}

/** One captured `POST /api/chat` request — its method, path, headers, and parsed JSON body. */
export interface CapturedRequest {
	readonly method: string
	readonly path: string
	readonly contentType: string | undefined
	/**
	 * Every request header (node lowercases the names), captured so a transport-seam
	 * test can assert a dynamically-injected header (an obfuscated bearer) reached the
	 * "server" — and that the base `content-type` is still present alongside it.
	 */
	readonly headers: Readonly<Record<string, string>>
	readonly body: Record<string, unknown>
}

/** A running stub Ollama daemon — its base `url`, the requests it `captured`, and `close`. */
export interface OllamaStub {
	readonly url: string
	readonly captured: readonly CapturedRequest[]
	close(): Promise<void>
}

// Read the whole request body, then parse it as JSON (an unparseable / empty body
// yields `{}` — the capture is best-effort, never throwing).
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const parts: Buffer[] = []
	for await (const part of request) parts.push(Buffer.from(part))
	const text = Buffer.concat(parts).toString('utf8')
	try {
		const parsed: unknown = JSON.parse(text)
		return parsed !== null && typeof parsed === 'object' ? { ...parsed } : {}
	} catch {
		return {}
	}
}

// Write the configured response — a streamed sequence of raw byte chunks (optionally
// left hanging), a raw string, an explicit empty body, or a single JSON body.
async function respond(response: ServerResponse, behavior: StubBehavior): Promise<void> {
	response.statusCode = behavior.status ?? 200
	if (behavior.chunks !== undefined) {
		response.setHeader('Content-Type', 'application/x-ndjson')
		for (const chunk of behavior.chunks) {
			response.write(Buffer.from(chunk))
			// Flush each chunk on its own task turn so the client reads them as distinct
			// reads — the only way to genuinely split a record across `reader.read()`s.
			await new Promise((resolve) => setImmediate(resolve))
		}
		if (behavior.hang === true) return // never end — the provider's deadline must trip
		response.end()
		return
	}
	if (behavior.empty === true) {
		// 204 No Content → `fetch` surfaces a null `response.body` (a 200 with no body is
		// a non-null stream that just ends — not the guard this exercises).
		response.statusCode = 204
		response.end()
		return
	}
	if (behavior.raw !== undefined) {
		response.end(behavior.raw)
		return
	}
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(behavior.body ?? {}))
}

/**
 * Start a stub Ollama daemon on an ephemeral port that answers the NEXT (and every)
 * `POST /api/chat` per `behavior`, capturing each request for assertion.
 *
 * @param behavior - How to answer `/api/chat` (status / body / raw / empty / chunks / hang)
 * @returns The running {@link OllamaStub} — its `url`, the `captured` requests, and `close`
 */
export async function startOllamaStub(behavior: StubBehavior): Promise<OllamaStub> {
	const captured: CapturedRequest[] = []
	const server: Server = createServer((request, response) => {
		void handle(request, response)
	})
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readBody(request)
		captured.push({
			method: request.method ?? '',
			path: request.url ?? '',
			contentType: request.headers['content-type'],
			headers: flattenHeaders(request.headers),
			body,
		})
		await respond(response, behavior)
	}
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	// `server.address()` is `AddressInfo | string | null`; narrow to the numeric port
	// off the object form (§14, no `as`) — an ephemeral listen always yields it.
	const address: unknown = server.address()
	const port = isRecord(address) && isNumber(address.port) ? address.port : 0
	return {
		url: `http://127.0.0.1:${port}`,
		get captured() {
			return captured
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)))
			})
		},
	}
}

/**
 * Serialize a record to one NDJSON line (a `\n`-terminated JSON object) as UTF-8
 * bytes — the unit an Ollama stream sends per line.
 *
 * @param record - The line's JSON object
 * @returns The `\n`-terminated UTF-8 bytes
 */
export function ndjsonLine(record: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(record)}\n`)
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
