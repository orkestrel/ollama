import type { MessageInterface } from '@orkestrel/agent'
import type { WorkspaceInterface } from '@orkestrel/workspace'

// ── Agent data-stub factory (real shape, not a mock) ─────────────────────────
//
// AGENTS §16.1: the repeated agent DATA shape — a user message — built ONCE as a
// parameterized factory so a test stubs the shape it needs. A REAL data builder,
// NOT a mock of behaviour. Environment-agnostic (only `@src/core` +
// `crypto.randomUUID`, global in node and Chromium), so it lives here.

/**
 * Build one user-turn {@link MessageInterface} — the storage layer assigns the `id`; the
 * provider sends only role + content over the wire. The drop-in author of a `user` message
 * across the agent + provider tests (live Ollama and Ollama-free alike).
 *
 * @param content - The user message's text content
 * @returns A user-role message with a minted id
 */
export function createUserMessage(content: string): MessageInterface {
	return { id: crypto.randomUUID(), role: 'user', content }
}

// ── Alternating conversation padding (AGENTS §16.1) ──────────────────────────
//
// The repeated "seed a long conversation with small-talk turns" shape folded into
// one deterministic builder — user-first, alternating, varying only by index so a
// test can seed any length without inline loops.

/**
 * Build `count` alternating user/assistant {@link MessageInterface}s (user first) — small-talk
 * padding turns whose content varies deterministically by index, for seeding long
 * conversations ahead of a compaction / window round-trip (AGENTS §16.1).
 *
 * @param count - How many turns to build
 * @returns `count` alternating turns, starting with `user`
 * @example
 * ```ts
 * buildTurns(2)
 * // [{ role: 'user', content: 'Small talk turn 0: ...' }, { role: 'assistant', content: 'Small talk turn 1: ...' }]
 * ```
 */
export function buildTurns(count: number): readonly MessageInterface[] {
	const turns: MessageInterface[] = []
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

// ── Throwing summarizer fixture (AGENTS §16.1) ────────────────────────────────
//
// The always-fails counterpart to a live `createLiveSummarizer` — a `summarize`
// fixture for compaction round-trips that assert on the NON-FATAL warn / error path
// rather than a successful digest. Matches `ConversationSummarizer` from
// `@orkestrel/agent`: `(messages: readonly MessageInterface[]) => Promise<string>`.

/** The message every {@link createThrowingSummarizer} invocation rejects with, by default. */
export const THROWING_SUMMARIZER_MESSAGE = 'throwing-summarizer-always-fails'

/**
 * Build a `summarize` function that always rejects — the compaction-failure fixture
 * (AGENTS §16.1). Compatible with `ConversationSummarizer`
 * (`(messages: readonly MessageInterface[]) => Promise<string>`).
 *
 * @param message - The rejection's `Error` message; defaults to {@link THROWING_SUMMARIZER_MESSAGE}
 * @returns A summarizer function that always rejects with `new Error(message)`
 */
export function createThrowingSummarizer(
	message: string = THROWING_SUMMARIZER_MESSAGE,
): (messages: readonly MessageInterface[]) => Promise<string> {
	return async () => {
		throw new Error(message)
	}
}

// ── Workspace seeder (AGENTS §16.1) ───────────────────────────────────────────
//
// Deterministic bulk-file seeding for a real @orkestrel/agent workspace — no
// randomness, fixed filler prose, so a workspace-driven test (context budget,
// document listing) is reproducible run to run.

/** Tuning for {@link fillWorkspace} — all optional. */
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

// A fixed, repeated sentence — deterministic filler with no randomness.
const FILLER_SENTENCE =
	'The quick brown fox jumps over the lazy dog and rests beneath the old oak tree. '

/**
 * Populate a {@link WorkspaceInterface} with deterministic filler files — `count` (default
 * `12`) text files named `doc-01.md` … `doc-NN.md`, each ~`bytesEach` (default `700`) bytes of
 * fixed repeated prose, plus an optional sentinel file at `sentinelPath` / `sentinelText`
 * (AGENTS §16.1). No randomness — same options, same workspace contents, every run.
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
