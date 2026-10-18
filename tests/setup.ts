import type { Message, ProviderRequest } from '@orkestrel/agent'
import type { RecorderInterface } from '@orkestrel/test'
import type { ToolDefinition, ToolInterface } from '@orkestrel/tool'
import type { WorkspaceInterface } from '@orkestrel/workspace'
import type { OllamaTiming } from '@src/core'
import { estimateMessages } from '@orkestrel/agent'
import { waitForDelay } from '@orkestrel/test'
import { isString } from '@orkestrel/contract'
import { createTool } from '@orkestrel/tool'

/**
 * Creates dependent lookup tools that reveal a code only for the returned challenge.
 *
 * @param challenge - The opaque value the first lookup returns
 * @param code - The code the second lookup returns for the correct challenge
 * @returns The challenge lookup followed by the secret lookup
 * @throws TypeError - Thrown when the secret lookup receives a missing or incorrect challenge.
 * @example
 * ```ts
 * const tools = createChallengeTools('opaque-challenge', '7193')
 * ```
 */
export function createChallengeTools(challenge: string, code: string): readonly ToolInterface[] {
	return [
		createTool({
			name: 'lookup_challenge',
			description: 'Look up the challenge required by lookup_secret. Takes no arguments.',
			parameters: { type: 'object', properties: {} },
			execute: () => ({ challenge }),
		}),
		createTool({
			name: 'lookup_secret',
			description:
				'Look up the secret access code using the challenge returned by lookup_challenge.',
			parameters: {
				type: 'object',
				properties: { challenge: { type: 'string' } },
				required: ['challenge'],
			},
			execute: (args) => {
				if (!isString(args.challenge) || args.challenge !== challenge) {
					throw new TypeError('The returned lookup challenge is required.')
				}
				return { code }
			},
		}),
	]
}

// ── Agent data-stub factory (real shape, not a mock) ─────────────────────────
//
// The repeated agent DATA shape — a user message — built ONCE as a parameterized
// factory so a test stubs the shape it needs. A REAL data builder, NOT a mock of
// behaviour. Environment-agnostic (only `@src/core` + `crypto.randomUUID`, global in
// node and Chromium), so it lives here.

/**
 * Builds one user-turn {@link Message} — the storage layer assigns the `id`; the
 * provider sends only role + content over the wire. The drop-in author of a `user` message
 * across the agent + provider tests (live Ollama and Ollama-free alike).
 *
 * @param content - The user message's text content
 * @returns A user-role message with a minted id
 */
export function createUserMessage(content: string): Message {
	return { id: crypto.randomUUID(), role: 'user', content }
}

// ── Alternating conversation padding ─────────────────────────────────────────
//
// The repeated "seed a long conversation with small-talk turns" shape folded into
// one deterministic builder — user-first, alternating, varying only by index so a
// test can seed any length without inline loops.

/**
 * Builds `count` alternating user/assistant {@link Message}s (user first) — small-talk
 * padding turns whose content varies deterministically by index, for seeding long
 * conversations ahead of a compaction / window round-trip.
 *
 * @param count - How many turns to build
 * @returns `count` alternating turns, starting with `user`
 * @example
 * ```ts
 * buildTurns(2)
 * // [{ role: 'user', content: 'Small talk turn 0: ...' }, { role: 'assistant', content: 'Small talk turn 1: ...' }]
 * ```
 */
export function buildTurns(count: number): readonly Message[] {
	const turns: Message[] = []
	for (let index = 0; index < count; index += 1) {
		const role = index % 2 === 0 ? 'user' : 'assistant'
		const content =
			role === 'user'
				? `Small talk turn ${index}: what do you think about topic ${index}?`
				: `Small talk turn ${index}: topic ${index} is interesting, thanks for asking.`
		turns.push({ id: crypto.randomUUID(), role, content })
	}
	return turns
}

// ── Window consumers ──────────────────────────────────────────────────────────
//
// An agent's `window` budget measures the complete provider request. These two consumers keep
// the live compaction tests' ceilings on the message text alone, so the tools a request
// advertises never move a fold the test places by message size.

/**
 * Counts the characters of every message a provider request carries, ignoring the advertised
 * tools and the call options.
 *
 * @param request - The provider request a window budget measures
 * @returns The summed `content` length of the request's messages
 * @example
 * ```ts
 * countRequestCharacters({ messages: [createUserMessage('abc')] }) // 3
 * ```
 */
export function countRequestCharacters(request: ProviderRequest): number {
	return request.messages.reduce((total, message) => total + message.content.length, 0)
}

/**
 * Estimates the token footprint of a provider request's messages alone, ignoring the advertised
 * tools and the call options.
 *
 * @param request - The provider request a window budget measures
 * @returns The estimated token count of the request's messages
 * @example
 * ```ts
 * estimateRequestMessages({ messages: [createUserMessage('hello')] }) // 6
 * ```
 */
export function estimateRequestMessages(request: ProviderRequest): number {
	return estimateMessages(request.messages)
}

// ── Summarizer fixtures ───────────────────────────────────────────────────────
//
// The always-fails counterpart to a live `createLiveSummarizer` — a `summarize`
// fixture for compaction round-trips that assert on the NON-FATAL warn / error path
// rather than a successful digest. Matches `ConversationSummaryHandler` from
// `@orkestrel/agent`: `(messages: readonly Message[]) => Promise<string>`.

/** Names the message every {@link createThrowingSummarizer} invocation rejects with, by default. */
export const THROWING_SUMMARIZER_MESSAGE = 'throwing-summarizer-always-fails'

/**
 * Builds a `summarize` function that always rejects — the compaction-failure fixture.
 * Compatible with `ConversationSummaryHandler`
 * (`(messages: readonly Message[]) => Promise<string>`).
 *
 * @param message - The rejection's `Error` message; defaults to {@link THROWING_SUMMARIZER_MESSAGE}
 * @returns A summarizer function that always rejects with `new Error(message)`
 */
export function createThrowingSummarizer(
	message: string = THROWING_SUMMARIZER_MESSAGE,
): (messages: readonly Message[]) => Promise<string> {
	return async () => {
		throw new Error(message)
	}
}

/** Names the digest every {@link createRecordingSummarizer} invocation resolves with, by default. */
export const RECORDING_SUMMARIZER_DIGEST = 'recording-summarizer-digest'

/**
 * Builds a `summarize` function that records the turns it was handed and then resolves a
 * fixed digest — the never-invoked / invoked-once fixture for a compaction round-trip
 * that asserts WHETHER the summarizer ran. Compatible with `ConversationSummaryHandler`
 * (`(messages: readonly Message[]) => Promise<string>`).
 *
 * @param recorder - The recorder each invocation hands its turns to
 * @param digest - The digest the summarizer resolves; defaults to {@link RECORDING_SUMMARIZER_DIGEST}
 * @returns A summarizer function that records its turns and resolves `digest`
 */
export function createRecordingSummarizer(
	recorder: RecorderInterface<[readonly Message[]]>,
	digest: string = RECORDING_SUMMARIZER_DIGEST,
): (messages: readonly Message[]) => Promise<string> {
	return async (messages) => {
		recorder.handler(messages)
		return digest
	}
}

// ── Workspace seeder ──────────────────────────────────────────────────────────
//
// Deterministic bulk-file seeding for a real @orkestrel/agent workspace — no
// randomness, fixed filler prose, so a workspace-driven test (context budget,
// document listing) is reproducible run to run.

/** Represents the tuning {@link fillWorkspace} accepts — all optional. */
export interface FillWorkspaceOptions {
	/** How many `doc-NN.md` files to write; defaults to `12`. */
	readonly count?: number
	/** Roughly how many bytes of filler prose each file holds; defaults to `700`. */
	readonly bytesEach?: number
	/** An extra file's path to write alongside the filler docs, paired with `sentinelText`. */
	readonly sentinelPath?: string
	/** The extra file's content, paired with `sentinelPath`. */
	readonly sentinelText?: string
}

/** Names the fixed sentence {@link fillWorkspace} repeats to fill each generated document. */
export const FILLER_SENTENCE =
	'The quick brown fox jumps over the lazy dog and rests beneath the old oak tree. '

/**
 * Populates a {@link WorkspaceInterface} with deterministic filler files — `count` (default
 * `12`) text files named `doc-01.md` … `doc-NN.md`, each ~`bytesEach` (default `700`) bytes of
 * fixed repeated prose, plus an optional sentinel file at `sentinelPath` / `sentinelText`
 * No randomness — same options, same workspace contents, every run.
 *
 * @param workspace - The {@link WorkspaceInterface} to write into
 * @param options - Optional {@link FillWorkspaceOptions} tuning
 * @example
 * ```ts
 * fillWorkspace(workspace, { count: 3, bytesEach: 100, sentinelPath: 'find-me.md', sentinelText: 'needle' })
 * ```
 */
export function fillWorkspace(workspace: WorkspaceInterface, options?: FillWorkspaceOptions): void {
	const count = options?.count ?? 12
	const bytesEach = options?.bytesEach ?? 700
	const repeats = Math.ceil(bytesEach / FILLER_SENTENCE.length)
	const filler = FILLER_SENTENCE.repeat(repeats).slice(0, bytesEach)
	for (let index = 1; index <= count; index += 1) {
		const name = `doc-${String(index).padStart(2, '0')}.md`
		workspace.write(name, filler)
	}
	if (options?.sentinelPath !== undefined && options.sentinelText !== undefined) {
		workspace.write(options.sentinelPath, options.sentinelText)
	}
}

// ── Page tool definition ──────────────────────────────────────────────────────
//
// The tool the live page proof registers with its in-page agent, declared here so
// the served page script, the model's advertised tool, and the test's wire
// assertions all read one definition across the string boundary.

/**
 * Defines the note-writing tool the page proof's in-page agent advertises.
 *
 * @remarks
 * The definition carries no handler: the page builds the executing tool from these
 * fields, and its handler mints a receipt and writes it into a real DOM element. The
 * receipt is minted during execution, so it cannot appear in the prompt and a model
 * answer that carries it can only have come from the page's own execution.
 */
export const PAGE_TOOL: ToolDefinition = Object.freeze({
	name: 'record',
	description: 'Write a note into the page and return the receipt the page minted for it.',
	parameters: {
		type: 'object',
		properties: { note: { type: 'string', description: 'The note to write into the page' } },
		required: ['note'],
	},
})

// ── Terminal timing fixtures ──────────────────────────────────────────────────
//
// One complete `done: true` record with a distinct value in every timing field, the reading
// the extractor must produce from it, the field matrix that pairs each wire key with its
// reading member, and the values the extractor must refuse. Inert data, shared by the
// timing proofs so no test restates the wire.

/** Pairs one wire key with the group and member of the timing reading that carries it. */
export type TimingField = readonly [key: string, group: 'durations' | 'counts', member: string]

/**
 * Holds one complete terminal record in raw nanoseconds and tokens.
 *
 * @remarks
 * Every timing field carries a distinct value, so a swapped mapping fails an assertion.
 */
export const TIMING_TERMINAL: Readonly<Record<string, unknown>> = Object.freeze({
	done: true,
	total_duration: 1234567890123,
	load_duration: 2345678,
	prompt_eval_duration: 345678901,
	eval_duration: 987654321,
	prompt_eval_count: 26,
	eval_count: 298,
	prompt_eval_cached_count: 12,
})

/** Holds the reading the extractor produces from {@link TIMING_TERMINAL}. */
export const TIMING_READING: OllamaTiming = Object.freeze({
	durations: Object.freeze({
		total: 1234567890123,
		load: 2345678,
		prompt: 345678901,
		decode: 987654321,
	}),
	counts: Object.freeze({ prompt: 26, decode: 298, cached: 12 }),
	invalid: Object.freeze([]),
})

/** Lists each wire key of {@link TIMING_TERMINAL} with the reading member that carries it, in wire order. */
export const TIMING_FIELDS: readonly TimingField[] = Object.freeze<TimingField[]>([
	['total_duration', 'durations', 'total'],
	['load_duration', 'durations', 'load'],
	['prompt_eval_duration', 'durations', 'prompt'],
	['eval_duration', 'durations', 'decode'],
	['prompt_eval_count', 'counts', 'prompt'],
	['eval_count', 'counts', 'decode'],
	['prompt_eval_cached_count', 'counts', 'cached'],
])

/** Lists the values no timing field may hold: not a non-negative safe integer. */
export const TIMING_HOSTILE: readonly unknown[] = Object.freeze<unknown[]>([
	'5',
	'',
	-1,
	-0,
	1.5,
	NaN,
	Infinity,
	-Infinity,
	Number.MAX_SAFE_INTEGER + 1,
	2 ** 64,
	5n,
	true,
	null,
	undefined,
	{},
	[],
	[5],
])

// ── Timer lead ────────────────────────────────────────────────────────────────
//
// The allowance an elapsed lower bound over a real host timer subtracts, declared in
// the host-independent setup file so every project can import it.

/**
 * Bounds, in whole milliseconds, how far a real host timer can end short of its duration on a
 * `performance.now()` span that opens before the timer is armed.
 *
 * @remarks
 * Node refreshes libuv's loop clock when it arms a timer, and stamps the timer with that clock
 * truncated to a whole millisecond. libuv reads `CLOCK_MONOTONIC_COARSE` when that clock ticks
 * every millisecond, so the stamp can trail the arming by under 1 ms of truncation plus under 1 ms
 * of coarse tick. The timer fires when the loop clock reaches the stamp plus the duration, so the
 * span can close up to this lead early. Synchronous work earlier in the arming macrotask does not
 * widen the shortfall, because the arming refreshes the clock. A timer armed when an earlier one
 * fires is stamped no earlier than that one's deadline, so a chain of deadlines falls short by at
 * most this lead in total. Assert a span that waits out `D` milliseconds of deadlines as at least
 * `D` minus this lead.
 */
export const TIMER_LEAD = 2

/**
 * Samples elapsed spans of 50 real 10 ms timers armed late in a loop-clock millisecond.
 *
 * @remarks
 * The fixed sample covers repeated loop-clock ticks for 500 ms of requested timer time,
 * retaining every span even after a short timer appears. Absence of a span below 10 ms means
 * only that this run did not observe early delivery, not that the host can never deliver early.
 * The caller supplies clock alignment so this module stays host-independent.
 *
 * @param align - Aligns the host loop clock, then spins for the supplied millisecond offset.
 * @returns Every elapsed span in milliseconds, measured with `performance.now()`.
 * @example
 * ```ts
 * const spans = await sampleTimerSpans(alignLoopClock)
 * const short = spans.some((span) => span < 10)
 * ```
 */
export async function sampleTimerSpans(
	align: (offset: number) => void,
): Promise<readonly number[]> {
	const spans: number[] = []
	for (let attempt = 0; attempt < 50; attempt += 1) {
		align(0.9)
		const started = performance.now()
		const delayed = waitForDelay(10)
		align(0)
		await delayed
		spans.push(performance.now() - started)
	}
	return spans
}

/** Holds the unchanged default encoded chat prefix for context-control proofs. */
export const OLLAMA_CONTEXT_PREFIX =
	'{"model":"test-model","messages":[{"role":"user","content":"hi"}],"stream":true,"keep_alive":"5m","think":false'

/** Holds independent and paired native chat context switches with their expected wire suffixes. */
export const OLLAMA_CONTEXT_CASES = Object.freeze([
	{ name: 'truncate false', control: { truncate: false }, suffix: ',"truncate":false' },
	{ name: 'truncate true', control: { truncate: true }, suffix: ',"truncate":true' },
	{ name: 'shift false', control: { shift: false }, suffix: ',"shift":false' },
	{ name: 'shift true', control: { shift: true }, suffix: ',"shift":true' },
	{
		name: 'both false',
		control: { truncate: false, shift: false },
		suffix: ',"truncate":false,"shift":false',
	},
	{
		name: 'both true',
		control: { truncate: true, shift: true },
		suffix: ',"truncate":true,"shift":true',
	},
	{
		name: 'truncate false with shift true',
		control: { truncate: false, shift: true },
		suffix: ',"truncate":false,"shift":true',
	},
	{
		name: 'truncate true with shift false',
		control: { truncate: true, shift: false },
		suffix: ',"truncate":true,"shift":false',
	},
] as const)

// ── Truncation reason matrices ────────────────────────────────────────────────
//
// The terminal `done_reason` values `extractTruncated` must refuse: every string other than the
// exact `'length'`, and every value that is not a string. Inert data, so the projection proof
// restates no wire value.

/** Lists the string `done_reason` values that do not read as truncation: anything but exactly `'length'`. */
export const TRUNCATED_STRING_REASONS: readonly string[] = Object.freeze([
	'stop',
	'load',
	'unload',
	'Length',
	'',
])

/** Lists the non-string `done_reason` values that do not read as truncation, one single-value case each. */
export const TRUNCATED_INVALID_REASONS: ReadonlyArray<[unknown]> = Object.freeze<Array<[unknown]>>([
	[6],
	[null],
	[['length']],
	[{ reason: 'length' }],
	[false],
])

// ── Canned chat stream ────────────────────────────────────────────────────────
//
// The NDJSON lines a canned daemon transport streams for the budget-layer proofs: three content
// deltas of eight characters each, then one terminal record whose reported usage (prompt 3,
// completion 9) differs from the delta estimate.

/** Lists the three content-delta lines of the canned chat stream, in wire order. */
export const CANNED_STREAM_DELTAS: readonly string[] = Object.freeze([
	'{"message":{"content":"abcdefgh"},"done":false}\n',
	'{"message":{"content":"ijklmnop"},"done":false}\n',
	'{"message":{"content":"qrstuvwx"},"done":false}\n',
])

/** Holds the terminal line of the canned chat stream: a `stop` reason with reported usage of 3 prompt and 9 completion tokens. */
export const CANNED_STREAM_DONE =
	'{"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":9}\n'

// ── Live prompts ──────────────────────────────────────────────────────────────
//
// The two prompts the live model-layer proofs share: one that invites an answer far longer than
// the token cap those proofs set, one that a model answers in a single word.

/** Holds the prompt that invites an answer far longer than a small `num_predict` cap. */
export const LONG_ANSWER_PROMPT =
	'Write a long, detailed essay about the history of the printing press.'

/** Holds the prompt a model answers in one word, well inside any token cap. */
export const SHORT_ANSWER_PROMPT = 'Reply with the single word OK.'
