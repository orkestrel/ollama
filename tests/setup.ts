import type { Message, ProviderDelta, ProviderRequest, ProviderResult } from '@orkestrel/agent'
import type { RecorderInterface } from '@orkestrel/test'
import type { ToolContext, ToolDefinition, ToolInterface } from '@orkestrel/tool'
import type { WorkspaceInterface } from '@orkestrel/workspace'
import type { Logprob, OllamaTiming } from '@src/core'
import { estimateMessages } from '@orkestrel/agent'
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
	return Array.from({ length: Math.ceil(count) }, (_, index) => {
		const role = index % 2 === 0 ? 'user' : 'assistant'
		const content =
			role === 'user'
				? `Small talk turn ${index}: what do you think about topic ${index}?`
				: `Small talk turn ${index}: topic ${index} is interesting, thanks for asking.`
		return { id: crypto.randomUUID(), role, content }
	})
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
	const names = Array.from(
		{ length: count },
		(_, offset) => `doc-${String(offset + 1).padStart(2, '0')}.md`,
	)
	for (const name of names) workspace.write(name, filler)
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

// ── Stack depth ───────────────────────────────────────────────────────────────
//
// A proof that a walk holds no frame per step cannot spend the stack and count what overflowed:
// how many frames fit depends on the host's stack size, on the frame size of each tier the engine
// has compiled a function to, and on whether the code under test was compiled before the call. A
// call near the stack floor can overflow before it runs a line. These helpers read the depth of
// the stack itself, which is the same on every host and tier: a walk that recurses per step
// reads a larger depth at each step, and a walk that loops reads the same depth at each.

/**
 * Reads how many frames the stack holds at the call.
 *
 * @returns The number of frames from the caller to the root of the stack, the reader's own included
 * @remarks Raises the engine's stack-trace limit for the read and restores it, so the whole stack
 * is counted. Inlined frames count as the frames the source declares.
 */
export function readStackDepth(): number {
	const limit = Error.stackTraceLimit
	Error.stackTraceLimit = Number.POSITIVE_INFINITY
	const depth = (new Error().stack ?? '').split('\n').length
	Error.stackTraceLimit = limit
	return depth
}

/**
 * Recurses through a stated number of frames and reports the stack depth at each.
 *
 * @param levels - How many frames to recurse through after the first
 * @param report - The function that receives the stack depth at each frame, outermost first
 * @example
 * ```ts
 * recordRecursion(2, (depth) => depths.push(depth)) // three strictly increasing depths
 * ```
 */
export function recordRecursion(levels: number, report: (depth: number) => void): void {
	report(readStackDepth())
	if (levels > 0) recordRecursion(levels - 1, report)
}

// ── Judge duplicate and iterator matrices ─────────────────────────────────────
//
// The top lists whose token repeats, and the iterator values a list must not carry, so the judge
// readers' duplicate and iterator proofs restate neither the lists nor the values.

/**
 * Builds the top lists whose token repeats the way a `Map` key repeats.
 *
 * @returns One two-entry list for a repeated `NaN`, one for `0` against `-0`, and one for a single
 * object held by both entries; the object is created for this call, so its identity is shared inside
 * the list and nowhere else
 * @remarks Each list keeps `logprob` finite. A reader that compared the tokens with `===` would
 * accept the `NaN` list and refuse the zero list, so the lists tell the two comparisons apart.
 */
export function buildRepeatedTokenCases(): ReadonlyArray<readonly Logprob[]> {
	const shared = {}
	return [
		[
			Object.assign({ token: 'x', logprob: 0 }, { token: Number.NaN }),
			Object.assign({ token: 'x', logprob: 0 }, { token: Number.NaN }),
		],
		[
			Object.assign({ token: 'x', logprob: 0 }, { token: 0 }),
			Object.assign({ token: 'x', logprob: 0 }, { token: -0 }),
		],
		[
			Object.assign({ token: 'x', logprob: 0 }, { token: shared }),
			Object.assign({ token: 'x', logprob: 0 }, { token: shared }),
		],
	]
}

/**
 * Lists a top list whose repeated token has another token between its two occurrences.
 *
 * @remarks A reader that compares a token with the previous token alone accepts this list, so only a
 * reader that compares every earlier token refuses it.
 */
export const NON_ADJACENT_DUPLICATE_TOP: readonly Logprob[] = Object.freeze([
	{ token: 'No', logprob: 0 },
	{ token: 'Yes', logprob: -1 },
	{ token: 'No', logprob: -2 },
])

/** Lists the values an array's iterator must not hold when a reader consumes it as `for…of` does. */
export const ABSENT_ITERATORS: readonly unknown[] = Object.freeze([undefined, null])

// ── List and record builders ──────────────────────────────────────────────────
//
// The lists and records whose shape a reader must meet as `for…of` meets it: holes, a missing or
// closing iterator, and reads that report themselves. No builder here knows a domain type, so
// every suite that proves a reader's laziness or iteration protocol imports them from this module.

/**
 * Builds a list whose undefined slots are holes.
 *
 * @param slots - The entries in position order; an `undefined` value leaves its position a hole
 * @returns A list of the same length that holds each defined entry at its position
 * @remarks A hole is a position the list has no entry for. An array literal cannot declare one
 * without an assertion, and `for…of` visits a hole as `undefined` where `map` skips it.
 */
export function buildSparseList<TValue>(slots: ReadonlyArray<TValue | undefined>): TValue[] {
	const list = new Array<TValue>(slots.length)
	for (const [index, slot] of slots.entries()) {
		if (slot !== undefined) list[index] = slot
	}
	return list
}

/**
 * Builds a list that has no iterator, which `for…of` refuses and `Array.from` reads as an array-like.
 *
 * @param slots - The entries in position order
 * @returns A list of the same entries whose `Symbol.iterator` property holds `undefined`
 */
export function buildIteratorlessList<TValue>(slots: readonly TValue[]): TValue[] {
	const list = [...slots]
	Object.defineProperty(list, Symbol.iterator, { value: undefined })
	return list
}

/**
 * Builds a list whose iterator reports when a consumer closes it before it ends.
 *
 * @param slots - The entries in position order
 * @param close - The function the iterator's `return` method calls
 * @returns A list of the same entries whose iterator yields them in order and calls `close` when a
 * `for…of` loop leaves early
 */
export function buildClosingList<TValue>(slots: readonly TValue[], close: () => void): TValue[] {
	const list = [...slots]
	Object.defineProperty(list, Symbol.iterator, {
		value() {
			return Object.assign(slots.values(), {
				return() {
					close()
					return { done: true, value: undefined }
				},
			})
		},
	})
	return list
}

/**
 * Builds a copy of a value that reports each read of one property.
 *
 * @param value - The value to copy
 * @param key - The property whose reads the copy reports
 * @param watch - The function the copy calls on every read of the property
 * @returns A copy whose property returns the original's value after it calls `watch`
 */
export function buildWatched<TValue extends object>(
	value: TValue,
	key: keyof TValue,
	watch: () => void,
): TValue {
	return Object.defineProperty({ ...value }, key, {
		enumerable: true,
		get() {
			watch()
			return value[key]
		},
	})
}

/**
 * Builds a copy of a record that reports each read of each of its own properties.
 *
 * @param value - The record to copy
 * @param watch - The function the copy calls on every read, with the name of the property read
 * @returns A copy whose own properties are getters that call `watch`, then return the original's value
 * @remarks Building the copy reads nothing from the copy, so `watch` hears only the reads a consumer makes.
 */
export function buildTracedRecord<TValue extends object>(
	value: TValue,
	watch: (key: string) => void,
): TValue {
	const traced = { ...value }
	for (const key of Object.keys(value)) {
		Object.defineProperty(traced, key, {
			enumerable: true,
			get() {
				watch(key)
				return Reflect.get(value, key)
			},
		})
	}
	return traced
}

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

// ── Short call options ────────────────────────────────────────────────────────

/**
 * Holds the sampling options of a short, deterministic call: eight predicted tokens at temperature 0.
 *
 * @remarks The live recipes and the hermetic wire scenarios derive their tables from this value, so
 * the number is stated once.
 */
export const SHORT_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

// ── Canned whole turns ────────────────────────────────────────────────────────
//
// The daemon's side of a whole turn, as the NDJSON chunks a canned transport streams, for the
// executed guide and README fences that stream a provider turn: one that opens its reasoning with a
// marker and one that opens it inline and reclassifies it later.

/** Holds the closing record every canned turn ends with: three prompt tokens and four completion tokens. */
export const DONE_RECORD = '{"done":true,"prompt_eval_count":3,"eval_count":4}\n'

/**
 * Lists the daemon's side of a whole turn, as newline-delimited records.
 *
 * @remarks The `Hel` and `lo` content spans, the `weighing it` reasoning span, and the `done` line
 * carrying the token counts.
 */
export const HELLO_TURN: readonly string[] = Object.freeze([
	'{"message":{"content":"Hel"}}\n',
	'{"message":{"thinking":"weighing it"}}\n{"message":{"content":"lo"}}\n',
	DONE_RECORD,
])

/**
 * Lists the same turn from a daemon that opens its reasoning inline without a `<think>` marker.
 *
 * @remarks The reasoning streams as content, and the bare `</think>` that follows reclassifies the
 * prefix the stream has already yielded.
 */
export const RECLASSIFIED_TURN: readonly string[] = Object.freeze([
	'{"message":{"content":"reasoning"}}\n',
	'{"message":{"content":"</think>answer"}}\n',
	DONE_RECORD,
])

/** Names the model the streaming fences in the README and the guide ask for. */
export const FENCE_MODEL = 'qwen3.5:2b-q4_K_M'

/** Holds the prompt the guide's streaming fence sends. */
export const GUIDE_FENCE_PROMPT = 'Say hello.'

/** Holds the prompt the README's fences send. */
export const README_FENCE_PROMPT = 'Reply with exactly: ok'

/** Names a line only the streaming fences in the README and the guide hold, which locates each block. */
export const STREAM_FENCE_ANCHOR = 'const deltas: ProviderDelta[] = []'

/** Names a line only the README's usage fence holds, which locates the block the streaming fence continues. */
export const USAGE_FENCE_ANCHOR = 'const result = await provider.generate(messages, abort.signal)'

/** Names each scenario the streaming fences are executed over, so a control names the one it is observed over without retyping its label. */
export const FENCE_SCENARIOS = Object.freeze({
	plain: 'a plain turn',
	reclassified: 'a reclassified turn',
	cancelled: 'a turn cancelled after its first delta',
	refused: 'a turn the daemon refuses',
})

/** Represents the error a fence threw, as the plain record the proofs compare. */
export interface FenceError {
	/** The error's `name`. */
	readonly name: string
	/** The error's `message`. */
	readonly message: string
	/** The error's `code` property; `undefined` when it holds none. */
	readonly code: unknown
	/** The error's `status` property; `undefined` when it holds none. */
	readonly status: unknown
}

/** Represents one daemon scenario the streaming fences in the README and the guide are executed over. */
export interface StreamFenceCase {
	/** Names the scenario. */
	readonly label: string
	/** Titles the case that runs the guide fence over the scenario. */
	readonly title: string
	/** The daemon's bytes, as newline-delimited records; a status other than 200 answers them as the error body. */
	readonly chunks: readonly string[]
	/** The HTTP status the daemon answers with. */
	readonly status: number
	/** If `true`, the daemon stays open after its bytes and the caller cancels once they are read; if `false`, the stream settles. */
	readonly cancel: boolean
	/** The values the guide fence logs, in order, as the arguments of each `console.log` call. */
	readonly guide: ReadonlyArray<readonly [unknown]>
	/** The values the README fence logs, in order, as the arguments of each `console.log` call. */
	readonly readme: ReadonlyArray<readonly [unknown]>
	/** The deltas the stream yields, in order, with the channel and the boundaries each one has; `undefined` for a turn the fence does not finish. */
	readonly deltas: readonly ProviderDelta[] | undefined
	/** The result the stream settles to, or `undefined` for a turn the caller cancels or the daemon refuses. */
	readonly settled: ProviderResult | undefined
	/** The error the guide fence throws, or `undefined` for a turn it finishes. */
	readonly thrown: FenceError | undefined
}

/**
 * Lists the scenarios the streaming fences are executed over, with what each fence must log.
 *
 * @remarks The plain turn joins to its settled content. The reclassified turn settles to content the
 * joined deltas no longer match, so the fence's reading of the settled result is what differs. The
 * cancelled turn reaches the guide fence's `catch` arm, which logs what streamed before the cancel
 * and leaves the README fence, which has no `catch` arm, out of the scenario. The refused turn
 * answers HTTP 404, which is not an abort, so the guide fence's `else` arm rethrows it and the
 * README fence is left out for the same reason.
 */
export const STREAM_FENCE_CASES: readonly StreamFenceCase[] = Object.freeze([
	{
		label: FENCE_SCENARIOS.plain,
		title: 'settles the content the stream fence reads, with the plain turn joining to it',
		chunks: HELLO_TURN,
		status: 200,
		cancel: false,
		guide: [['Hello'], ['Hello'], ['weighing it']],
		readme: [['Hello'], ['Hello']],
		deltas: [
			{ channel: 'content', text: 'Hel' },
			{ channel: 'thinking', text: 'weighing it' },
			{ channel: 'content', text: 'lo' },
		],
		settled: {
			content: 'Hello',
			thinking: 'weighing it',
			usage: { prompt: 3, completion: 4, total: 7 },
		},
		thrown: undefined,
	},
	{
		label: FENCE_SCENARIOS.reclassified,
		title: 'settles the reclassified turn to content the joined deltas no longer match',
		chunks: RECLASSIFIED_TURN,
		status: 200,
		cancel: false,
		guide: [['answer'], ['reasoninganswer'], ['']],
		readme: [['answer'], ['reasoninganswer']],
		deltas: [
			{ channel: 'content', text: 'reasoning' },
			{ channel: 'content', text: 'answer' },
		],
		settled: {
			content: 'answer',
			thinking: 'reasoning',
			usage: { prompt: 3, completion: 4, total: 7 },
		},
		thrown: undefined,
	},
	{
		label: FENCE_SCENARIOS.cancelled,
		title: 'recovers the partial the catch arm reads, undoubled, when the stream is cancelled',
		chunks: ['{"message":{"content":"Hel"}}\n'],
		status: 200,
		cancel: true,
		guide: [['Hel']],
		readme: [],
		deltas: [{ channel: 'content', text: 'Hel' }],
		settled: undefined,
		thrown: undefined,
	},
	{
		label: FENCE_SCENARIOS.refused,
		title: 'rethrows what the daemon refused, because the catch arm reads only an abort',
		chunks: ['{"error":"model \'qwen3.5:2b-q4_K_M\' not found"}\n'],
		status: 404,
		cancel: false,
		guide: [],
		readme: [],
		deltas: undefined,
		settled: undefined,
		thrown: {
			name: 'ProviderError',
			message: 'provider error: 404 - {"error":"model \'qwen3.5:2b-q4_K_M\' not found"}\n',
			code: 'HTTP',
			status: 404,
		},
	},
])

/** Represents what one run of a fence did, as the proofs read it. */
export interface FenceObservation {
	/** The arguments of each `console.log` call, in order. */
	readonly logged: ReadonlyArray<readonly [unknown]>
	/** The fence's `deltas` binding after its last line ran; `undefined` when the fence threw. */
	readonly deltas: unknown
	/** The fence's `messages` binding as written, ids and roles included; `undefined` when the fence threw. */
	readonly messages: unknown
	/** The whole body of each request the fence sent through the recording transport, in order. */
	readonly requests: ReadonlyArray<Readonly<Record<string, unknown>>>
	/** What the fence threw; `undefined` when it finished. */
	readonly error: FenceError | undefined
}

/**
 * Builds the message list a streaming fence declares for a prompt.
 *
 * @param prompt - The prompt the fence sends
 * @returns The fence's one user message, with the id and role it spells
 */
export function buildFenceMessages(
	prompt: string,
): ReadonlyArray<Readonly<Record<string, string>>> {
	return [{ id: '1', role: 'user', content: prompt }]
}

/**
 * Builds the whole request body the provider sends for a streaming fence's prompt.
 *
 * @param prompt - The prompt the fence sends
 * @returns The wire body: the fence's model, its one user message without an id, the streaming flag,
 * and the provider's default keep-alive and thinking switch
 */
export function buildFenceBody(prompt: string): Readonly<Record<string, unknown>> {
	return {
		model: FENCE_MODEL,
		messages: [{ role: 'user', content: prompt }],
		stream: true,
		keep_alive: '5m',
		think: false,
	}
}

/**
 * Builds what a run of a fence over a scenario must observe.
 *
 * @param scenario - The scenario the fence ran over
 * @param fence - Which fence ran
 * @returns The logged values, the bindings, the whole request bodies, and the error the scenario states
 * @remarks The README fence sends two requests, its usage fence's `generate` and its streaming
 * fence's `stream`. A cancelled run sends none through the recording transport, which the open
 * transport it rides is not wrapped by. A run that threw returns neither binding.
 */
export function buildFenceObservation(
	scenario: StreamFenceCase,
	fence: 'guide' | 'readme',
): FenceObservation {
	const prompt = fence === 'guide' ? GUIDE_FENCE_PROMPT : README_FENCE_PROMPT
	const body = buildFenceBody(prompt)
	const finished = scenario.thrown === undefined
	return {
		logged: fence === 'guide' ? scenario.guide : scenario.readme,
		deltas: scenario.deltas,
		messages: finished ? buildFenceMessages(prompt) : undefined,
		requests: scenario.cancel ? [] : fence === 'guide' ? [body] : [body, body],
		error: scenario.thrown,
	}
}

/** Represents one edit to a streaming fence that executing the fence must observe. */
export interface FenceControl {
	/** Names the edit. */
	readonly label: string
	/** Names the fence the edit applies to. */
	readonly fence: 'guide' | 'readme'
	/** Matches the first text the edit replaces. */
	readonly pattern: RegExp
	/** The text that replaces the match; `$1` stands for the pattern's first group. */
	readonly replacement: string
	/** Names the {@link FENCE_SCENARIOS} scenario the edit is observed over. */
	readonly scenario: string
}

/**
 * Lists the edits that keep a fence valid TypeScript and change what it does, one of each kind in
 * each fence the kind reaches.
 *
 * @remarks Each edit is a literal inside a string, a comment that swallows the next line, a mapped
 * value, a dropped import, the model name, a message's role or id, a provider option, a transport
 * the fence supplies itself, or the arm that rethrows. An edit that only reformats the fence is
 * outside the list, because the executed run must not observe it.
 */
export const FENCE_CONTROLS: readonly FenceControl[] = Object.freeze([
	{
		label: "turns join('') into join(' ') in the guide",
		fence: 'guide',
		pattern: /answer\.join\(''\)/u,
		replacement: "answer.join(' ')",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "turns join('') into join(' ') in the README",
		fence: 'readme',
		pattern: /answer\.join\(''\)/u,
		replacement: "answer.join(' ')",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'merges the newline after the trailing comment into it in the guide',
		fence: 'guide',
		pattern: /(authoritative one)\n\s*/u,
		replacement: '$1 ',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'merges the newline after the trailing comment into it in the README',
		fence: 'readme',
		pattern: /(authoritative one)\n\s*/u,
		replacement: '$1 ',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'doubles the space inside the guide prompt',
		fence: 'guide',
		pattern: /Say hello\./u,
		replacement: 'Say  hello.',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'doubles the space inside the README prompt',
		fence: 'readme',
		pattern: /Reply with exactly: ok/u,
		replacement: 'Reply with exactly:  ok',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "maps every delta to 'wrong' in the guide",
		fence: 'guide',
		pattern: /\.map\(\(delta\) => delta\.text\)/u,
		replacement: ".map(() => 'wrong')",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "maps every delta to 'wrong' in the README",
		fence: 'readme',
		pattern: /\.map\(\(delta\) => delta\.text\)/u,
		replacement: ".map(() => 'wrong')",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'drops the isProviderAbortError import from the guide',
		fence: 'guide',
		pattern: /import \{ isProviderAbortError \} from '@orkestrel\/agent'\n/u,
		replacement: '',
		scenario: FENCE_SCENARIOS.cancelled,
	},
	{
		label: 'drops the createOllama import from the README',
		fence: 'readme',
		pattern: /import \{ createOllama \} from '@orkestrel\/ollama'\n/u,
		replacement: '',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'changes the model name in the guide',
		fence: 'guide',
		pattern: /qwen3\.5:2b-q4_K_M/u,
		replacement: 'qwen3.5:2b-q4_K_S',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'changes the model name in the README',
		fence: 'readme',
		pattern: /qwen3\.5:2b-q4_K_M/u,
		replacement: 'qwen3.5:2b-q4_K_S',
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "changes the message role from 'user' to 'assistant' in the guide",
		fence: 'guide',
		pattern: /role: 'user'/u,
		replacement: "role: 'assistant'",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "changes the message role from 'user' to 'assistant' in the README",
		fence: 'readme',
		pattern: /role: 'user'/u,
		replacement: "role: 'assistant'",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "changes the message id from '1' to '2' in the guide",
		fence: 'guide',
		pattern: /id: '1'/u,
		replacement: "id: '2'",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: "changes the message id from '1' to '2' in the README",
		fence: 'readme',
		pattern: /id: '1'/u,
		replacement: "id: '2'",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'turns on the think provider option in the guide',
		fence: 'guide',
		pattern: /createOllama\(\{ model: 'qwen3\.5:2b-q4_K_M' \}\)/u,
		replacement: "createOllama({ model: 'qwen3.5:2b-q4_K_M', think: true })",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'turns on the think provider option in the README',
		fence: 'readme',
		pattern: /createOllama\(\{ model: 'qwen3\.5:2b-q4_K_M' \}\)/u,
		replacement: "createOllama({ model: 'qwen3.5:2b-q4_K_M', think: true })",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'supplies a transport that rejects in the guide',
		fence: 'guide',
		pattern: /createOllama\(\{ model: 'qwen3\.5:2b-q4_K_M' \}\)/u,
		replacement:
			"createOllama({ model: 'qwen3.5:2b-q4_K_M', fetch: () => Promise.reject(new Error('fence transport refused')) })",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'supplies a transport that rejects in the README',
		fence: 'readme',
		pattern: /createOllama\(\{ model: 'qwen3\.5:2b-q4_K_M' \}\)/u,
		replacement:
			"createOllama({ model: 'qwen3.5:2b-q4_K_M', fetch: () => Promise.reject(new Error('fence transport refused')) })",
		scenario: FENCE_SCENARIOS.plain,
	},
	{
		label: 'logs the error the else arm rethrows in the guide',
		fence: 'guide',
		pattern: /\} else throw error/u,
		replacement: '} else console.log(error)',
		scenario: FENCE_SCENARIOS.refused,
	},
])

/**
 * Extracts the fenced code block that holds a line.
 *
 * @param markdown - The Markdown text
 * @param anchor - A line of the block, compared after trimming
 * @returns Every line of the first block that holds a line equal to `anchor`, from the line after
 * its opening fence to the line before its closing fence, imports included; `undefined` when no
 * block holds such a line
 * @remarks The whole block is the subject of an executed proof, so a line above or below the anchor
 * is as much part of the block as the anchor is.
 * @example
 * ```ts
 * extractAnchoredFence('```ts\nconst a = 1\n```', 'const a = 1') // 'const a = 1'
 * ```
 */
export function extractAnchoredFence(markdown: string, anchor: string): string | undefined {
	const lines = markdown.split(/\r\n|\n/u)
	const wanted = anchor.trim()
	const fences = lines.flatMap((line, index) => (line.startsWith('```') ? [index] : []))
	for (const [position, opening] of fences.entries()) {
		const closing = fences[position + 1]
		if (position % 2 !== 0 || closing === undefined) continue
		const block = lines.slice(opening + 1, closing)
		if (block.some((line) => line.trim() === wanted)) return block.join('\n')
	}
	return undefined
}

// ── Live prompts ──────────────────────────────────────────────────────────────
//
// The two prompts the live model-layer proofs share: one that invites an answer far longer than
// the token cap those proofs set, one that a model answers in a single word.

/** Holds the prompt that invites an answer far longer than a small `num_predict` cap. */
export const LONG_ANSWER_PROMPT =
	'Write a long, detailed essay about the history of the printing press.'

/** Holds the prompt a model answers in one word, well inside any token cap. */
export const SHORT_ANSWER_PROMPT = 'Reply with the single word OK.'

// ── Case deadlines and timing ─────────────────────────────────────────────────
//
// The deadlines the agent-driving suites share: the ordinary case deadline a run and its case are
// both given, and the real per-call deadline the provider deadline proofs arm with the wait that
// reads whether it fired.

/** Names the deadline, in milliseconds, an ordinary agent run and the case that drives it are given. */
export const CASE_TIMEOUT = 60_000

/** Names the deadline, in milliseconds, a case that retries a long generation is given: twice {@link CASE_TIMEOUT}. */
export const HEAVY_TIMEOUT = CASE_TIMEOUT * 2

/** Names the real per-call deadline the provider deadline proofs arm, in milliseconds. */
export const DEADLINE_MS = 25

/** Names how long the provider deadline proofs wait past {@link DEADLINE_MS} before reading whether it fired. */
export const SETTLE_MS = DEADLINE_MS * 4

// ── Tool context ──────────────────────────────────────────────────────────────

/**
 * Holds a non-aborted context for the tool `execute` calls a proof makes.
 *
 * @remarks None of the tool fixtures read `context.caller`, so a signal alone satisfies
 * `ToolContext`.
 */
export const TOOL_CONTEXT: ToolContext = { signal: new AbortController().signal }

// ── Binary image fixture ──────────────────────────────────────────────────────

/**
 * Holds a tiny 1x1 transparent PNG, base64-encoded.
 *
 * @remarks A hardcoded binary fixture: a small deterministic binary payload inline rather than a
 * generated one.
 */
export const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
