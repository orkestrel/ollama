import type { ConversationInterface, Message } from '@orkestrel/agent'
import { isRecord, isString } from '@orkestrel/contract'
import { createOllama, OLLAMA_CHAT_PATH, OllamaProvider } from '@src/core'
import { SHORT_OPTIONS } from './setup.js'
import { env, withScheme } from './setupServer.js'

/** Names the live daemon and model selected for the service axis. */
export const OLLAMA_CONFIG = Object.freeze({
	host: withScheme(env('OLLAMA_HOST', 'http://localhost:11434')),
	model: env('OLLAMA_MODEL', 'qwen3.5:2b-q4_K_M'),
})

/** Names the live Mica calibration and the native decision model. */
export const OLLAMA_JUDGE_CONFIG = Object.freeze({
	model: env('OLLAMA_JUDGE_MODEL', 'hf.co/sky7350/Mica-v0.1-4B:Q4_K_M'),
	temperature: Number(env('OLLAMA_JUDGE_TEMPERATURE', '1.1244734010661372')),
	decision: env('OLLAMA_DECISION_MODEL', 'tev1:0.8b'),
})

/** Represents the tuning a live Ollama test provider accepts. */
export interface LiveProviderOptions {
	/** The Ollama `num_predict` cap; defaults to `32`. */
	readonly predict?: number
	/** The sampling temperature; defaults to `0` for reproducible fixtures. */
	readonly temperature?: number
	/** The Ollama `num_ctx` window in tokens; omission leaves the daemon's default window. */
	readonly context?: number
	/** The provider's deadline for one turn in milliseconds; omission leaves the provider's default. */
	readonly turn?: number
	/** The `/api/chat` `think` flag; omission leaves the provider's default, which is `false`. */
	readonly think?: boolean
}

/**
 * Builds a concrete provider against the selected live daemon and warmed model.
 *
 * @param options - Optional prediction, temperature, window, turn-deadline, and thinking overrides
 * @returns A concrete provider configured for the service axis
 */
export function createLiveOllama(options?: LiveProviderOptions): OllamaProvider {
	return new OllamaProvider({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: {
			num_predict: options?.predict ?? 32,
			temperature: options?.temperature ?? 0,
			...(options?.context === undefined ? {} : { num_ctx: options.context }),
		},
		...(options?.turn === undefined ? {} : { timeout: options.turn }),
		...(options?.think === undefined ? {} : { think: options.think }),
	})
}

/**
 * Builds a live summarizer for conversation-compaction scenarios.
 *
 * The fixed summarization instruction is appended as the final user turn because a
 * reasoning chat model may treat a prompt ending on an assistant turn as already
 * answered and emit no digest.
 *
 * @param timeoutMs - The generation deadline in milliseconds
 * @param predict - The summarizer's `num_predict` cap; defaults to `64`
 * @returns A conversation summarizer backed by the warmed live model
 */
export function createLiveSummarizer(
	timeoutMs: number,
	predict = 64,
): (messages: readonly Message[]) => Promise<string> {
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

/**
 * Seeds a conversation with the fixed trip-planning exchange compaction round-trips fold.
 *
 * The seeded turns are long enough that a one-sentence digest is measurably shorter, so a
 * post-compaction `view()` is provably smaller than the seeded one.
 *
 * @param conversation - The conversation to add the turns to
 */
export function seedConversation(conversation: ConversationInterface): void {
	conversation.add([
		{ role: 'user', content: 'My name is Ada and I am planning a trip to Kyoto in spring.' },
		{
			role: 'assistant',
			content: 'Kyoto in spring is lovely — the cherry blossoms peak in early April.',
		},
		{ role: 'user', content: 'I want to visit temples and try traditional food.' },
		{
			role: 'assistant',
			content: 'Fushimi Inari and Kinkaku-ji are must-sees; try kaiseki and yudofu.',
		},
	])
}

/**
 * Checks whether the daemon answers and reports the selected model as installed.
 *
 * @param selected - The required model; defaults to the provider service model
 * @returns `true` only when `/api/tags` succeeds and includes the configured model
 */
export async function isOllamaReady(selected = OLLAMA_CONFIG.model): Promise<boolean> {
	try {
		const response = await fetch(`${OLLAMA_CONFIG.host}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		})
		if (!response.ok) return false
		const body: unknown = await response.json()
		if (!isRecord(body) || !Array.isArray(body.models)) return false
		return body.models.some(
			(model) =>
				isRecord(model) &&
				((isString(model.name) && model.name === selected) ||
					(isString(model.model) && model.model === selected)),
		)
	} catch {
		return false
	}
}

/**
 * Requests a daemon route and reports a failed attempt as an error that names the cause.
 *
 * @param url - The absolute URL to request
 * @param init - The request options, without the deadline signal
 * @param timeout - The deadline in milliseconds, armed inside the attempt
 * @param message - Builds the error message from the text of the failure
 * @returns The daemon's response, whatever its status
 * @throws Thrown when the deadline cannot be armed or the request cannot be made, carrying the failure as its cause.
 * @example
 * ```ts
 * const response = await fetchDaemon(`${OLLAMA_CONFIG.host}/api/tags`, {}, 5000, (reason) => `no daemon (${reason})`)
 * ```
 */
export async function fetchDaemon(
	url: string,
	init: RequestInit,
	timeout: number,
	message: (reason: string) => string,
): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
	} catch (error) {
		throw new Error(message(String(error)), { cause: error })
	}
}

/**
 * Warms the selected model with a one-token chat request.
 *
 * @param selected - The model to warm; defaults to the provider service model
 * @param timeout - The warmup deadline in milliseconds; default 300000 for Mica and 120000 otherwise
 * @returns A promise that resolves after the response body has been drained
 * @throws When the daemon cannot be reached or rejects the warmup
 */
export async function warmOllama(
	selected = OLLAMA_CONFIG.model,
	timeout = selected === OLLAMA_JUDGE_CONFIG.model ? 300_000 : 120_000,
): Promise<void> {
	const response = await fetchDaemon(
		`${OLLAMA_CONFIG.host}/api/chat`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: selected,
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
				think: false,
				options: { num_predict: 1 },
				keep_alive: '30m',
			}),
		},
		timeout,
		(reason) =>
			`Ollama warmup could not reach ${OLLAMA_CONFIG.host} for model ${selected} (${reason})`,
	)
	if (!response.ok) {
		throw new Error(
			`Ollama warmup failed (${response.status}) for model ${selected} at ${OLLAMA_CONFIG.host}`,
		)
	}
	await response.text()
}

/** Names the request options for content and usage round-trips. */
export const FAST_OPTIONS = Object.freeze({ ...SHORT_OPTIONS })

/** Names the request options for multi-delta streaming round-trips. */
export const STREAM_OPTIONS = Object.freeze({ num_predict: 16, temperature: 0 })

/** Names the request options for tool-call round-trips. */
export const TOOL_OPTIONS = Object.freeze({ num_predict: 32, temperature: 0 })

/** Names the request options for mid-stream abort and deadline round-trips. */
export const ABORT_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

/** Names the request options for seeded deterministic round-trips. */
export const SEED_OPTIONS = Object.freeze({ ...SHORT_OPTIONS, seed: 42 })

/** Names the request options for native-thinking round-trips. */
export const THINK_OPTIONS = Object.freeze({ ...SHORT_OPTIONS })

/**
 * Names the elapsed-time bound every live retry gives the `retryUntil` helper, in milliseconds.
 *
 * @remarks A live attempt is a real generation, so the shipped default budget of 1000 ms would
 * cut a bounded retry short after its first attempt. This value matches the `service` project's
 * own 120000 ms test timeout, which leaves the attempt count as the bound that ends a retry and
 * the runner's timeout as the bound on the wall clock.
 */
export const RETRY_BUDGET = 120_000

/** Names the request options for the two-turn tool-loop recipe. */
export const TOOL_LOOP_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

/**
 * Names the request options for the live page proof's direct daemon turn.
 *
 * @remarks The cap is above `FAST_OPTIONS` because that case asserts the daemon answered the
 * prompt it was given rather than that it answered at all, and a model that opens with a
 * reasoning prefix spends the first few tokens before the answer begins.
 */
export const PAGE_OPTIONS = Object.freeze({ num_predict: 32, temperature: 0 })

/** Represents one sampling table paired with the name of the export that holds it. */
export type SamplingTable = readonly [name: string, table: Readonly<Record<string, unknown>>]

/**
 * Lists every sampling table above under its own export name, in declaration order.
 *
 * @remarks A proof that holds all the tables to one invariant reads this population rather than
 * restating it, so a table added above joins that proof by joining this list.
 */
export const SAMPLING_TABLES: readonly SamplingTable[] = Object.freeze<SamplingTable[]>([
	['FAST_OPTIONS', FAST_OPTIONS],
	['STREAM_OPTIONS', STREAM_OPTIONS],
	['TOOL_OPTIONS', TOOL_OPTIONS],
	['ABORT_OPTIONS', ABORT_OPTIONS],
	['SEED_OPTIONS', SEED_OPTIONS],
	['THINK_OPTIONS', THINK_OPTIONS],
	['TOOL_LOOP_OPTIONS', TOOL_LOOP_OPTIONS],
	['PAGE_OPTIONS', PAGE_OPTIONS],
])

/**
 * Lists the sampling tables a second time, each under its own export name, stated apart from
 * {@link SAMPLING_TABLES}.
 *
 * @remarks A proof compares the two lists entry by entry, by reference, so a table added to one list
 * and not the other, a name that points at the wrong table, and a swapped pair of equal tables each
 * fail it.
 */
export const SAMPLING_EXPORTS: readonly SamplingTable[] = Object.freeze<SamplingTable[]>([
	['FAST_OPTIONS', FAST_OPTIONS],
	['STREAM_OPTIONS', STREAM_OPTIONS],
	['TOOL_OPTIONS', TOOL_OPTIONS],
	['ABORT_OPTIONS', ABORT_OPTIONS],
	['SEED_OPTIONS', SEED_OPTIONS],
	['THINK_OPTIONS', THINK_OPTIONS],
	['TOOL_LOOP_OPTIONS', TOOL_LOOP_OPTIONS],
	['PAGE_OPTIONS', PAGE_OPTIONS],
])

// ── Live page proof daemon gate ───────────────────────────────────────────────
//
// The one precondition the live page proof needs from the daemon, a hard throw naming
// its own fix. It resolves on call. This module itself contacts the daemon at load, so
// only the `service` project and the fixture-hosted `tests/setupService.test.ts` may
// import it; the Node-only gates that need no daemon are in `tests/setupServer.ts`.

/**
 * Checks that the daemon answers a cross-origin preflight for the page's own origin.
 *
 * @param origin - The page origin the daemon must permit, such as `http://127.0.0.1:54321`
 * @throws Thrown when the preflight cannot be made, is refused, or permits another origin.
 * @remarks The relay case never needs this, because the page and the relay share one origin.
 * The direct case does: the page dials the daemon from an ephemeral loopback origin, so the
 * browser sends an `OPTIONS` preflight first and the daemon decides it. A host where that
 * preflight fails is a host where the guide's direct-daemon claim is false, so the failure is
 * a throw naming `OLLAMA_ORIGINS` rather than a skip.
 */
export async function requireDaemonOrigin(origin: string): Promise<void> {
	const url = `${OLLAMA_CONFIG.host}${OLLAMA_CHAT_PATH}`
	const response = await fetchDaemon(
		url,
		{
			method: 'OPTIONS',
			headers: {
				origin,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		},
		10_000,
		(reason) =>
			`The page proof could not preflight ${url} for origin ${origin} (${reason}); start the daemon`,
	)
	const allowed = response.headers.get('access-control-allow-origin')
	if (!response.ok || (allowed !== origin && allowed !== '*')) {
		throw new Error(
			`The Ollama daemon at ${OLLAMA_CONFIG.host} refuses the page origin ${origin} ` +
				`(status ${String(response.status)}, access-control-allow-origin ${String(allowed)}); ` +
				'set OLLAMA_ORIGINS to include that origin and restart the daemon',
		)
	}
}

if (!(await isOllamaReady())) {
	throw new Error(
		`Ollama service tests require ${OLLAMA_CONFIG.model} at ${OLLAMA_CONFIG.host}; start the daemon and pull the model`,
	)
}
await warmOllama()
