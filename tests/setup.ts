import type { MessageInterface } from '@orkestrel/agent'

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

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

/**
 * Drain an `AsyncIterable<T>` (an agent chunk stream, a provider delta stream) into an
 * array — the assertion-friendly counterpart to a streaming read (AGENTS §16.1).
 *
 * @typeParam T - The element type yielded by the iterable
 * @param iterable - The async source to consume to completion
 * @returns Every yielded value, in iteration order
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = []
	for await (const value of iterable) values.push(value)
	return values
}
