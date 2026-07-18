import type { ContextFormatInterface, MessageInterface, ToolDefinition } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { isProviderAbortError } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { isOllamaHTTPError, OllamaProvider } from '@src/server'
import { describe, expect, it, vi } from 'vitest'
import { createRecorder, createUserMessage } from '../../setup.js'
import {
	ABORT_OPTIONS,
	createLiveOllama,
	createRecordingProxy,
	drive,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	retryUntil,
	SEED_OPTIONS,
	STREAM_OPTIONS,
	THINK_OPTIONS,
	TOOL_OPTIONS,
	waitForRequest,
} from '../../setupServer.js'

// OllamaProvider — LIVE-ONLY (AGENTS §16 — no mocks; only genuine third-party calls;
// per-project USER DIRECTIVE: NO fabricated/stub Ollama responses anywhere in this
// file). Two complementary techniques:
//
//  • LIVE (against a REAL local Ollama daemon): `setupServer.ts` throws if the daemon
//    is unreachable and warms the model, so these tests run unconditionally. Every
//    request uses a named, frozen recipe (`FAST_OPTIONS` / `STREAM_OPTIONS` /
//    `TOOL_OPTIONS` / `ABORT_OPTIONS` / `SEED_OPTIONS` / `THINK_OPTIONS`) tuned to the
//    minimum `num_predict` that reliably exercises the behavior. Assertions are
//    STRUCTURAL/invariant-based — never exact model prose.
//
//  • RECORDING PROXY (`createRecordingProxy`, a real `@orkestrel/server` +
//    `@orkestrel/router` pass-through that forwards VERBATIM to the real daemon and
//    returns its REAL response unaltered): used to assert WHAT THE PROVIDER SENDS ON
//    THE WIRE (body shape, headers, framing) — a provider-behavior assertion, never a
//    model-behavior one. The response outcome from these calls is irrelevant (the
//    proxy records the request before forwarding, so even a daemon-rejected edge shape
//    still records); such calls `.catch(() => {})` the outcome.

// A weather tool the model can call — a tightly-constrained single-arg function so a
// warmed qwen3.5:2b reliably emits ONE tool call when told to use it.
const WEATHER_TOOL: ToolDefinition = {
	name: 'get_weather',
	description: 'Get the current weather for a city.',
	parameters: {
		type: 'object',
		properties: { city: { type: 'string', description: 'The city name' } },
		required: ['city'],
	},
}

describe('OllamaProvider (live — generate)', () => {
	// Recipe: 'Say hello.' / num_predict:8 (FAST_OPTIONS) / think:false.
	// Assertion: structural — non-empty content.
	it('returns assembled content for a prompt', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)

		expect(result.content.length).toBeGreaterThan(0)
	})

	// Recipe: 'Reply with exactly: ok' / num_predict:8 (FAST_OPTIONS) / think:false —
	// short prompt kept for brevity only.
	// Assertion: structural — non-empty content (never asserts the model OBEYED the
	// prompt's wording — that would be a model-behavior assertion, forbidden by doctrine).
	it('a constrained short prompt yields non-empty content', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()

		const result = await provider.generate(
			[createUserMessage('Reply with exactly: ok')],
			abort.signal,
		)

		expect(result.content.length).toBeGreaterThan(0)
	})

	// Recipe: 'Say hello.' / num_predict:8 (FAST_OPTIONS) / think:false.
	// Assertion: structural — usage counters positive and consistent.
	it('reports token usage with prompt + completion summing to total', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()

		const result = await provider.generate([createUserMessage('Say hello.')], abort.signal)

		expect(result.usage).toBeDefined()
		const usage = result.usage
		if (usage === undefined) throw new Error('usage missing')
		expect(usage.prompt).toBeGreaterThan(0)
		expect(usage.completion).toBeGreaterThan(0)
		expect(usage.total).toBe(usage.prompt + usage.completion)
	})

	// Recipe: 'Reply with exactly: ok' / num_predict:8 (FAST_OPTIONS) / think:false.
	// Assertion: structural — no <think> reasoning trace leaks into content.
	it('keeps thinking OFF — no <think> reasoning trace leaks into content', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()

		const result = await provider.generate(
			[createUserMessage('Reply with exactly: ok')],
			abort.signal,
		)

		expect(result.content).not.toContain('<think>')
		expect(result.content).not.toContain('</think>')
	})

	// Recipe: 'What is the weather in Paris? Use the get_weather tool.' / num_predict:32
	// (TOOL_OPTIONS) / think:false. Assertion: structural — tool-call shape
	// (non-empty id, correct name, object arguments). Bounded retry (attempts=3, per
	// directive #7) over the small model's nondeterminism — probe measured 3/3 hit rate,
	// but a small sample, so each attempt reissues the SAME call until one carries at
	// least one tool call; the strict shape assertions then run on that response.
	it('populates result.tools when the model calls a tool (id/name/arguments)', async () => {
		const provider = createLiveOllama({ predict: TOOL_OPTIONS.num_predict })

		const result = await retryUntil(
			() =>
				provider.generate(
					[createUserMessage('What is the weather in Paris? Use the get_weather tool.')],
					createAbort().signal,
					[WEATHER_TOOL],
				),
			(value) => (value.tools ?? []).length > 0,
			'produce a tool_call for get_weather',
			3,
		)

		const tools = result.tools ?? []
		expect(tools.length).toBeGreaterThan(0)
		for (const call of tools) {
			expect(call.id.length).toBeGreaterThan(0)
			expect(call.name).toBe('get_weather')
			expect(isRecord(call.arguments)).toBe(true)
		}
	})

	// Recipe: 'Say hi.' / num_predict:8 (FAST_OPTIONS) / think:false, no thinking.
	// Assertion: structural — no empty `thinking` optional when none was produced.
	it('omits thinking when the turn produced none', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()

		const result = await provider.generate([createUserMessage('Say hi.')], abort.signal)

		expect('thinking' in result).toBe(false)
	})

	// Recipe: 'What color is the sky? Reply in one short sentence.' / num_predict:8
	// (THINK_OPTIONS) / think:true. Assertion: structural — thinking present and
	// non-empty, content carries no raw <think> tags (native message.thinking channel).
	// Content may be empty under this small cap (thinking drains the budget first).
	it('surfaces native thinking on result.thinking when think:true, with clean content', async () => {
		const provider = createLiveOllama({ predict: THINK_OPTIONS.num_predict, format: undefined })
		const abort = createAbort()

		const result = await provider.generate(
			[createUserMessage('What color is the sky? Reply in one short sentence.')],
			abort.signal,
			undefined,
			{ think: true },
		)

		expect(result.thinking).toBeDefined()
		expect((result.thinking ?? '').length).toBeGreaterThan(0)
		expect(result.content).not.toContain('<think>')
		expect(result.content).not.toContain('</think>')
	})

	// Recipe: 'Say only the word hello.' / inline { num_predict: 320, temperature: 0 }
	// / think:true. Calibration note: a live probe at temperature:0 measured this
	// prompt's full reasoning trace at eval_count≈206 tokens before content began — 320
	// gives ~55% headroom so the trace can FINISH and the answer can land in content
	// (do not shrink this back toward THINK_OPTIONS-scale; it will go vacuous again,
	// per the sibling case above where content "may be empty"). Assertion: structural —
	// thinking non-empty, content non-empty (the think→content transition seam: the
	// model finished reasoning and the answer landed in the CONTENT channel, not lost
	// or misrouted), and content does not contain the thinking text (channel
	// separation). Bounded retry (attempts=3, directive #7) over the small model's
	// nondeterminism at this budget.
	it('finishes reasoning and lands the answer in content, not lost or misrouted (think→content seam)', async () => {
		const result = await retryUntil(
			async () => {
				const provider = new OllamaProvider({
					model: OLLAMA_CONFIG.model,
					url: OLLAMA_CONFIG.host,
					think: true,
					options: { num_predict: 320, temperature: 0 },
				})
				return provider.generate(
					[createUserMessage('Say only the word hello.')],
					createAbort().signal,
					undefined,
					{ think: true },
				)
			},
			(value) => (value.thinking ?? '').length > 0 && value.content.length > 0,
			'finish reasoning AND land the answer in content within the calibrated think budget',
			3,
		)

		expect((result.thinking ?? '').length).toBeGreaterThan(0)
		expect(result.content.length).toBeGreaterThan(0)
		const thinking = result.thinking ?? ''
		expect(result.content).not.toContain(thinking)
	})

	// Recipe: 'Say hi.' / num_predict:8, temperature:0, seed:42 (SEED_OPTIONS) /
	// think:false. Assertion: exact-match — seeded determinism (probe: 2/2 identical).
	it('produces byte-identical content across two calls with the same seed', async () => {
		const provider = new OllamaProvider({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options: SEED_OPTIONS,
			think: false,
		})
		const messages = [createUserMessage('Say hi.')]

		const first = await provider.generate(messages, createAbort().signal)
		const second = await provider.generate(messages, createAbort().signal)

		expect(second.content).toBe(first.content)
	})
})

describe('OllamaProvider (live — stream)', () => {
	// Recipe: 'Say hello there.' / num_predict:16 (STREAM_OPTIONS) / think:false.
	// Assertion: structural — deltas non-empty, result.content equals joined deltas,
	// usage present (usage present ⇒ total===prompt+completion invariant).
	it('yields content ProviderDeltas and RETURNS the assembled result', async () => {
		const provider = createLiveOllama({ predict: STREAM_OPTIONS.num_predict })
		const abort = createAbort()

		const { deltas, result } = await drive(
			provider.stream([createUserMessage('Say hello there.')], abort.signal),
		)

		expect(deltas.length).toBeGreaterThan(0)
		for (const delta of deltas) expect(typeof delta).toBe('string')
		expect(result.content.length).toBeGreaterThan(0)
		expect(result.content).toBe(deltas.join(''))
		expect(result.usage).toBeDefined()
		const usage = result.usage
		if (usage === undefined) throw new Error('usage missing')
		expect(usage.total).toBe(usage.prompt + usage.completion)
	})

	// Recipe: 'List the numbers one through ten, one per line.' / num_predict:16
	// (STREAM_OPTIONS) / think:false. Assertion: structural — more than one delta
	// arrives (proves incremental streaming, not one lump).
	it('streams a longer answer incrementally — more than one content delta', async () => {
		const provider = createLiveOllama({ predict: STREAM_OPTIONS.num_predict })
		const abort = createAbort()

		const { deltas, result } = await drive(
			provider.stream(
				[createUserMessage('List the numbers one through ten, one per line.')],
				abort.signal,
			),
		)

		expect(deltas.length).toBeGreaterThan(1)
		expect(result.content).toBe(deltas.join(''))
	})

	// Recipe: 'What is the weather in Tokyo? Use the get_weather tool.' / num_predict:32
	// (TOOL_OPTIONS) / think:false. Assertion: structural — tool calls assembled across
	// stream lines, correct name, non-empty id. Bounded retry (attempts=3, per
	// directive #7) over the small model's nondeterminism — probe measured 3/3 hit rate,
	// but a small sample, so each attempt reissues the SAME call until one carries at
	// least one tool call; the strict shape assertions then run on that response.
	it('assembles tool calls from a streamed turn', async () => {
		const provider = createLiveOllama({ predict: TOOL_OPTIONS.num_predict })

		const result = await retryUntil(
			async () =>
				(
					await drive(
						provider.stream(
							[createUserMessage('What is the weather in Tokyo? Use the get_weather tool.')],
							createAbort().signal,
							[WEATHER_TOOL],
						),
					)
				).result,
			(value) => (value.tools ?? []).length > 0,
			'produce a tool_call for get_weather',
			3,
		)

		const tools = result.tools ?? []
		expect(tools.length).toBeGreaterThan(0)
		expect(tools.every((call) => call.name === 'get_weather')).toBe(true)
		expect(tools.every((call) => call.id.length > 0)).toBe(true)
		// Usage is present and coherent on the SAME tool-call response — proving usage
		// reporting isn't dropped when the streamed turn ends in a tool call rather than
		// plain content.
		expect(result.usage).toBeDefined()
		const usage = result.usage
		if (usage === undefined) throw new Error('usage missing')
		expect(usage.prompt).toBeGreaterThan(0)
		expect(usage.completion).toBeGreaterThan(0)
		expect(usage.total).toBe(usage.prompt + usage.completion)
	})

	// Recipe: 'What color is the sky? Explain briefly.' / num_predict:8 (THINK_OPTIONS)
	// / think:true. Assertion: structural — at least one thinking delta arrives, and
	// any content that arrives is clean of raw <think> tags.
	it('streams at least one thinking delta when think:true, with clean content', async () => {
		const provider = new OllamaProvider({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			think: true,
			options: THINK_OPTIONS,
		})
		const abort = createAbort()

		const { thoughts, result } = await drive(
			provider.stream([createUserMessage('What color is the sky? Explain briefly.')], abort.signal),
		)

		expect(thoughts.length).toBeGreaterThan(0)
		for (const thought of thoughts) expect(thought.length).toBeGreaterThan(0)
		expect(result.content).not.toContain('<think>')
		expect(result.content).not.toContain('</think>')
	})
})

describe('OllamaProvider (live — abort)', () => {
	it('rejects generate when the signal is already aborted', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()
		abort.abort()

		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})

	it('rejects stream when the signal is already aborted (before any content)', async () => {
		const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict })
		const abort = createAbort()
		abort.abort()

		const generator = provider.stream([createUserMessage('Say hello.')], abort.signal)
		await expect(generator.next()).rejects.toThrow(Error)
	})

	// Recipe: 'Count slowly from 1 to 40, one number per line.' / num_predict:64
	// (ABORT_OPTIONS) / think:false. Aborts the CLIENT signal right after the first
	// delta arrives — mid-stream cancellation. Assertion: structural —
	// ProviderAbortError carrying non-empty partial content.
	it('throws ProviderAbortError with the partial content when aborted mid-stream', async () => {
		const provider = createLiveOllama({ predict: ABORT_OPTIONS.num_predict })
		const abort = createAbort()

		const generator = provider.stream(
			[createUserMessage('Count slowly from 1 to 40, one number per line.')],
			abort.signal,
		)
		const first = await generator.next()
		expect(first.done).toBe(false)
		abort.abort()

		let caught: unknown
		try {
			for (;;) {
				const step = await generator.next()
				if (step.done) break
			}
		} catch (error) {
			caught = error
		}

		expect(isProviderAbortError(caught)).toBe(true)
		if (!isProviderAbortError(caught)) throw new Error('expected ProviderAbortError')
		expect(caught.partial.content.length).toBeGreaterThan(0)
	})

	// Recipe: 'Count slowly from 1 to 100, one number per line.' / num_predict:64
	// (ABORT_OPTIONS) / think:false, provider timeout:2000ms — the PROVIDER'S OWN
	// deadline (not the caller's signal) trips mid-stream on a genuinely long output.
	// Assertion: structural — ProviderAbortError with non-empty partial content.
	it('its own timeout aborts a slow stream with ProviderAbortError carrying the partial', async () => {
		const provider = new OllamaProvider({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			timeout: 2000,
			options: ABORT_OPTIONS,
		})
		const abort = createAbort()

		let caught: unknown
		try {
			await drive(
				provider.stream(
					[createUserMessage('Count slowly from 1 to 100, one number per line.')],
					abort.signal,
				),
			)
		} catch (error) {
			caught = error
		}

		expect(isProviderAbortError(caught)).toBe(true)
		if (!isProviderAbortError(caught)) throw new Error('expected ProviderAbortError')
		expect(caught.partial.content.length).toBeGreaterThan(0)
	})
})

// ── DROPPED test blocks (fabricated-response coverage — forbidden by the live-only
// doctrine) ────────────────────────────────────────────────────────────────────────
//
// This project previously carried tests that verified the provider's defensive §14
// narrowing of malformed wire values, its ThinkSplitter integration on inline and
// chunk-split reasoning tags, and its decoder's line and character reassembly across
// artificially split network chunks. Every one of those cases was reachable only by
// fabricating an Ollama response body or by deliberately chunking the wire bytes in an
// unnatural way, and the live-only doctrine for this file forbids fabricated or
// stubbed daemon responses. All of that coverage was therefore dropped rather than
// kept as disabled or skipped tests. The live-reachable branches — a present usage
// object, object-shaped tool arguments, clean content with no leaked reasoning tags,
// content equal to the joined stream deltas, native message thinking, and real 404 and
// 400 errors from the daemon — remain covered by the live tests above. The underlying
// split, parse, and narrowing primitives themselves are owned and unit-tested by their
// originating packages: ThinkSplitter by @orkestrel/agent, the NDJSON line parser by
// @orkestrel/ndjson, and the record, string, and number guards by @orkestrel/contract.
// In summary, the dropped coverage spanned three families: think-separation cases
// covering an in-content split tag, a boundary held across chunks, an unclosed span at
// stream end, an implicit leading open across both stream and generate, daemon-side
// stubbed thinking deltas, and a shared-splitter check across generate calls; response
// narrowing cases covering an exact usage count, a missing-usage-to-undefined
// fallback, tool-argument branches for a JSON string, garbage text, and a non-object
// value, a malformed tool-call drop, a non-JSON SyntaxError, and empty-object and array
// degrade paths; and streaming-wire cases covering multi-byte reassembly across a
// byte-split boundary, skipping empty-content lines, tool calls spanning multiple
// lines, and a null response body. The stub 500/503 error-text tests were replaced by
// the live 404/400 tests below, and the stub-hang deadline test was replaced by the
// live own-timeout test above.

// The XML-group framing used across the format guards — wrap instructions in a
// `<instructions>…</instructions>` group.
const FRAMING: ContextFormatInterface = {
	instructions: {
		open: '<instructions>',
		render: (one) => `<instruction>${one.content}</instruction>`,
		close: '</instructions>',
	},
}

describe('OllamaProvider (context-framing format — no network)', () => {
	it('exposes the configured ContextFormatInterface verbatim (satisfies the optional ProviderInterface.format)', () => {
		const provider = new OllamaProvider({
			model: 'm',
			url: 'http://localhost:11434',
			format: FRAMING,
		})

		expect(provider.format).toBe(FRAMING)
	})

	it("defaults format to undefined when omitted (the framing-agnostic default ⇒ core's built-ins)", () => {
		const provider = new OllamaProvider({ model: 'm', url: 'http://localhost:11434' })

		expect(provider.format).toBeUndefined()
	})
})

// ── Recording-proxy request-shape tests (real wire assertions, real daemon behind
// the proxy) ──────────────────────────────────────────────────────────────────────
//
// Standard pattern: create a proxy, point a provider at it, generate or stream through
// it while swallowing the outcome (a daemon-rejected edge shape is tolerated since the
// proxy records the request before forwarding), then assert on the recorded request
// body and headers.

describe('OllamaProvider (recording proxy — request body)', () => {
	// Recipe: 'hello' / num_predict:7, temperature:0.5 / think:false (constructor default).
	// Assertion: provider-behavior — exact wire body shape (model/stream/keep_alive/
	// think/options/messages/tools).
	it('posts model/messages/stream/keep_alive and the default think:false; options + tools when set', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				keepAlive: '9m',
				options: { num_predict: 7, temperature: 0.5 },
			})
			await provider
				.generate([createUserMessage('hello')], createAbort().signal, [WEATHER_TOOL])
				.catch(() => {})

			expect(proxy.requests.length).toBe(1)
			const request = proxy.requests[0]
			if (request === undefined) throw new Error('no recorded request')
			expect(request.method).toBe('POST')
			expect(request.path).toBe('/api/chat')
			const body = request.body
			expect(body.model).toBe(OLLAMA_CONFIG.model)
			expect(body.stream).toBe(false)
			expect(body.keep_alive).toBe('9m')
			expect(body.think).toBe(false)
			expect(body.options).toEqual({ num_predict: 7, temperature: 0.5 })
			expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
			expect(body.tools).toEqual([
				{
					type: 'function',
					function: {
						name: 'get_weather',
						description: 'Get the current weather for a city.',
						parameters: WEATHER_TOOL.parameters,
					},
				},
			])
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / no options set / think:false (default). Assertion: provider-
	// behavior — keep_alive defaults to '5m', neither options nor tools key present.
	// bounded by abort-once-recorded, no generation awaited.
	it('defaults keep_alive to 5m and omits options/tools when unset', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			const body = proxy.requests[0]?.body ?? {}
			expect(body.keep_alive).toBe('5m')
			expect('options' in body).toBe(false)
			expect('tools' in body).toBe(false)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / no options / think:true (constructor). Assertion: provider-
	// behavior — think:true rides the wire verbatim.
	// bounded by abort-once-recorded, no generation awaited.
	it('carries think:true on the wire when the option is set', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				think: true,
			})
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.think).toBe(true)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / no options / think omitted. Assertion: provider-behavior —
	// think:false rides the wire by default.
	// bounded by abort-once-recorded, no generation awaited.
	it('carries the default think:false on the wire when the option is omitted', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.think).toBe(false)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / constructor think:true, per-call think:false. Assertion:
	// provider-behavior — per-call think overrides the constructor default.
	// bounded by abort-once-recorded, no generation awaited.
	it('per-call think overrides the constructor default', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				think: true,
			})
			const abort = createAbort()
			const pending = provider
				.generate([createUserMessage('hi')], abort.signal, undefined, { think: false })
				.catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.think).toBe(false)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / constructor think omitted (false), per-call think:true.
	// Assertion: provider-behavior — per-call think can enable over a false default.
	// bounded by abort-once-recorded, no generation awaited.
	it('per-call think can enable reasoning over a constructor default of false', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = provider
				.generate([createUserMessage('hi')], abort.signal, undefined, { think: true })
				.catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.think).toBe(true)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / an EMPTY tools array passed. Assertion: provider-behavior —
	// no `tools` key rides the wire for an empty array.
	// bounded by abort-once-recorded, no generation awaited.
	it('omits the tools key when an EMPTY tools array is passed', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal, []).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect('tools' in (proxy.requests[0]?.body ?? {})).toBe(false)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / streaming path. Assertion: provider-behavior — stream:true rides
	// the wire on the streaming path.
	// bounded by abort-once-recorded, no generation awaited.
	it('sets stream:true on the streaming path', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = drive(provider.stream([createUserMessage('hi')], abort.signal)).catch(
				() => {},
			)
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.stream).toBe(true)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: a 4-turn system/user/assistant(with tool_calls)/tool conversation.
	// Assertion: provider-behavior — every role maps to the wire shape and the
	// assistant's tool_calls replay verbatim.
	// bounded by abort-once-recorded, no generation awaited.
	it('maps every role (system/user/assistant/tool) and replays assistant tool_calls', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const messages: readonly MessageInterface[] = [
				{ id: '1', role: 'system', content: 'sys' },
				{ id: '2', role: 'user', content: 'u' },
				{
					id: '3',
					role: 'assistant',
					content: '',
					calls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }],
				},
				{ id: '4', role: 'tool', content: 'sunny' },
			]
			const abort = createAbort()
			const pending = provider.generate(messages, abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.messages).toEqual([
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'u' },
				{
					role: 'assistant',
					content: '',
					tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
				},
				{ role: 'tool', content: 'sunny' },
			])
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: an EMPTY messages array. Assertion: provider-behavior — sends an empty
	// array on the wire (daemon rejects with a 400; outcome tolerated).
	// bounded by abort-once-recorded, no generation awaited.
	it('accepts an empty messages array (sends [])', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = provider.generate([], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.messages).toEqual([])
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: one user turn with base64 images, one without. Assertion: provider-
	// behavior — images forwarded verbatim only when present (daemon may reject a
	// non-vision model; outcome tolerated).
	// bounded by abort-once-recorded, no generation awaited.
	it('forwards a multimodal turn’s base64 images onto the wire message (only when present)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const messages: readonly MessageInterface[] = [
				{ id: '1', role: 'user', content: 'Describe this.', images: ['aGVsbG8=', 'd29ybGQ='] },
				{ id: '2', role: 'user', content: 'No image here.' },
			]
			const abort = createAbort()
			const pending = provider.generate(messages, abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.messages).toEqual([
				{ role: 'user', content: 'Describe this.', images: ['aGVsbG8=', 'd29ybGQ='] },
				{ role: 'user', content: 'No image here.' },
			])
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: a user turn with an EMPTY images array. Assertion: provider-behavior —
	// the empty optional never rides the wire.
	// bounded by abort-once-recorded, no generation awaited.
	it('omits images for an empty images array (no empty optional on the wire)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const messages: readonly MessageInterface[] = [
				{ id: '1', role: 'user', content: 'hi', images: [] },
			]
			const abort = createAbort()
			const pending = provider.generate(messages, abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.messages).toEqual([{ role: 'user', content: 'hi' }])
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / a context-framing format configured. Assertion: provider-
	// behavior — the same-name `format` (context-framing) NEVER crosses onto the
	// Ollama wire body.
	// bounded by abort-once-recorded, no generation awaited.
	it('NEVER sends the context-framing format on the /api/chat wire (the same-name collision guard)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				format: FRAMING,
			})
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect('format' in (proxy.requests[0]?.body ?? {})).toBe(false)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: a system+user conversation through the proxy. Assertion: provider-
	// behavior — the FULL ordered conversation rides the wire (not just the last
	// message) — a provider-behavior replacement for the model-obedience "system →
	// blue" test, which asserted MODEL behavior (forbidden by doctrine).
	// bounded by abort-once-recorded, no generation awaited.
	it('sends the whole conversation (system + user) in order on the wire', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const messages: readonly MessageInterface[] = [
				{
					id: crypto.randomUUID(),
					role: 'system',
					content: 'You only ever answer with the single word: blue.',
				},
				{ id: crypto.randomUUID(), role: 'user', content: 'What is your favorite color?' },
			]
			const abort = createAbort()
			const pending = provider.generate(messages, abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.body.messages).toEqual([
				{ role: 'system', content: 'You only ever answer with the single word: blue.' },
				{ role: 'user', content: 'What is your favorite color?' },
			])
		} finally {
			await proxy.stop()
		}
	})
})

describe('OllamaProvider (recording proxy — structured-output schema)', () => {
	// Recipe: 'Give me a city and its population.' / num_predict:64, temperature:0 /
	// think:false / options.schema constraining {city:string, population:number}.
	// Assertion: wire-truth — the recorded body carries `format` deep-equal to the
	// schema (deterministic); response-shape — the assembled content JSON.parses to an
	// object with a string `city` and a numeric `population` (bounded retry, attempts=3,
	// per directive #7, over the small model's nondeterminism at this budget). Also
	// proves the negative: a schema-less call on the SAME proxy carries no `format` key.
	const SCHEMA = {
		type: 'object',
		properties: { city: { type: 'string' }, population: { type: 'number' } },
		required: ['city', 'population'],
	} as const

	it('sends the schema as `format` on the wire and returns matching structured JSON; omits format when no schema is given', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				options: { num_predict: 64, temperature: 0 },
			})

			const result = await retryUntil(
				() =>
					provider.generate(
						[createUserMessage('Give me a city and its population.')],
						createAbort().signal,
						undefined,
						{ think: false, schema: SCHEMA },
					),
				(value) => {
					try {
						const parsed: unknown = JSON.parse(value.content)
						return (
							isRecord(parsed) &&
							typeof parsed.city === 'string' &&
							typeof parsed.population === 'number'
						)
					} catch {
						return false
					}
				},
				'return content that JSON.parses to {city: string, population: number}',
				3,
			)

			const schemaRequest = proxy.requests[proxy.requests.length - 1]
			if (schemaRequest === undefined) throw new Error('no recorded request')
			expect(schemaRequest.body.format).toEqual(SCHEMA)

			const parsed: unknown = JSON.parse(result.content)
			if (!isRecord(parsed)) throw new Error('content did not parse to an object')
			expect(typeof parsed.city).toBe('string')
			expect(typeof parsed.population).toBe('number')

			const abort = createAbort()
			const expectedCount = proxy.requests.length + 1
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy, expectedCount)
			abort.abort()
			await pending

			const noSchemaRequest = proxy.requests[proxy.requests.length - 1]
			if (noSchemaRequest === undefined) throw new Error('no recorded request')
			expect('format' in noSchemaRequest.body).toBe(false)
		} finally {
			await proxy.stop()
		}
	})
})

describe('OllamaProvider (recording proxy — transport seam headers)', () => {
	// bounded by abort-once-recorded, no generation awaited.
	it('merges a dynamically-injected header onto the request (the obfuscated token reaches the server)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				headers: () => ({ authorization: 'Bearer obfuscated-xyz' }),
			})
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			const request = proxy.requests[0]
			if (request === undefined) throw new Error('no recorded request')
			expect(request.headers.authorization).toBe('Bearer obfuscated-xyz')
			expect(request.headers['content-type']).toBe('application/json')
		} finally {
			await proxy.stop()
		}
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('applies an ASYNC headers hook (a Promise-returning injector resolves and is merged)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				headers: async () => {
					await Promise.resolve()
					return { authorization: 'Bearer async-token', 'x-extra': '1' }
				},
			})
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			const request = proxy.requests[0]
			if (request === undefined) throw new Error('no recorded request')
			expect(request.headers.authorization).toBe('Bearer async-token')
			expect(request.headers['x-extra']).toBe('1')
			expect(request.headers['content-type']).toBe('application/json')
		} finally {
			await proxy.stop()
		}
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('lets the hook override Content-Type when it explicitly returns one', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				headers: () => ({ 'Content-Type': 'application/json; charset=utf-8' }),
			})
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.headers['content-type']).toBe('application/json; charset=utf-8')
		} finally {
			await proxy.stop()
		}
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('the headers hook applies on the STREAMING path too', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				headers: () => ({ authorization: 'Bearer stream-token' }),
			})
			const abort = createAbort()
			const pending = drive(provider.stream([createUserMessage('hi')], abort.signal)).catch(
				() => {},
			)
			await waitForRequest(proxy)
			abort.abort()
			await pending

			expect(proxy.requests[0]?.headers.authorization).toBe('Bearer stream-token')
			expect(proxy.requests[0]?.headers['content-type']).toBe('application/json')
		} finally {
			await proxy.stop()
		}
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('sends ONLY the base Content-Type when headers is omitted (default unchanged)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: proxy.url })
			const abort = createAbort()
			const pending = provider.generate([createUserMessage('hi')], abort.signal).catch(() => {})
			await waitForRequest(proxy)
			abort.abort()
			await pending

			const request = proxy.requests[0]
			if (request === undefined) throw new Error('no recorded request')
			expect(request.headers['content-type']).toBe('application/json')
			expect(request.headers.authorization).toBeUndefined()
		} finally {
			await proxy.stop()
		}
	})
})

describe('OllamaProvider (recording proxy — transport seam custom fetch)', () => {
	// Recipe: 'hi' / FAST_OPTIONS-scale (default options) / think:false. Assertion:
	// provider-behavior — the injected fetch is the one used (a real delegating
	// recorder per AGENTS §16.1, not a mock), exactly once, and the real content
	// still comes back through it.
	it('uses the injected fetch, not the global (a real delegating recorder)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const calls = createRecorder<readonly [string]>()
			const transport: typeof globalThis.fetch = (input, init) => {
				calls.handler(String(input))
				return globalThis.fetch(input, init)
			}
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				fetch: transport,
				options: FAST_OPTIONS,
			})
			const result = await provider.generate([createUserMessage('hi')], createAbort().signal)

			expect(calls.count).toBe(1)
			expect(calls.calls[0]?.[0]).toBe(`${proxy.url}/api/chat`)
			expect(result.content.length).toBeGreaterThan(0)
			expect(proxy.requests.length).toBe(1)
		} finally {
			await proxy.stop()
		}
	})

	it('threads a custom fetch through the STREAMING path', async () => {
		const proxy = await createRecordingProxy()
		try {
			const calls = createRecorder<readonly [string]>()
			const transport: typeof globalThis.fetch = (input, init) => {
				calls.handler(String(input))
				return globalThis.fetch(input, init)
			}
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				fetch: transport,
				options: FAST_OPTIONS,
			})
			const { result } = await drive(
				provider.stream([createUserMessage('hi')], createAbort().signal),
			)

			expect(calls.count).toBe(1)
			expect(result.content.length).toBeGreaterThan(0)
		} finally {
			await proxy.stop()
		}
	})
})

describe('OllamaProvider (transport seam — orthogonal to the deadline)', () => {
	it('a pre-aborted signal with a headers hook still rejects cleanly, leaking no timer', async () => {
		vi.useFakeTimers()
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				headers: () => ({ authorization: 'Bearer x' }),
			})
			const abort = createAbort()
			abort.abort()

			await expect(provider.generate([createUserMessage('hi')], abort.signal)).rejects.toThrow(
				Error,
			)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	// Recipe: no network reached (the hook rejects before send). Assertion:
	// provider-behavior — the armed deadline is cleared and NOTHING reaches the proxy.
	it('an async-headers hook that REJECTS clears the deadline (no leaked timer)', async () => {
		vi.useFakeTimers()
		try {
			const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
			try {
				const provider = new OllamaProvider({
					model: OLLAMA_CONFIG.model,
					url: OLLAMA_CONFIG.host,
					timeout: 90_000,
					headers: () => Promise.reject(new Error('token fetch failed')),
				})
				await expect(
					provider.generate([createUserMessage('hi')], createAbort().signal),
				).rejects.toThrow('token fetch failed')
				expect(vi.getTimerCount()).toBe(0)
				expect(proxy.requests.length).toBe(0)
			} finally {
				await proxy.stop()
			}
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('OllamaProvider (live error status)', () => {
	// Recipe: model 'does-not-exist:zzz' — a genuine 404 from the real daemon.
	// Assertion: structural — a typed OllamaHTTPError with status 404, message
	// still mentioning the status.
	it('throws with the status and body text on a non-OK response (live 404 bad model)', async () => {
		const provider = new OllamaProvider({ model: 'does-not-exist:zzz', url: OLLAMA_CONFIG.host })
		const abort = createAbort()

		let caught: unknown
		try {
			await provider.generate([createUserMessage('hi')], abort.signal)
		} catch (error) {
			caught = error
		}

		expect(isOllamaHTTPError(caught)).toBe(true)
		if (!isOllamaHTTPError(caught)) throw new Error('expected OllamaHTTPError')
		expect(caught.status).toBe(404)
		expect(caught.message).toMatch(/Ollama API error: 404/)
	})

	// Recipe: an empty model string — a genuine 400 "model is required" from the real
	// daemon. Assertion: structural — a typed OllamaHTTPError with status 400.
	it('throws with the status on a non-OK response (live 400 missing model)', async () => {
		const provider = new OllamaProvider({ model: '', url: OLLAMA_CONFIG.host })
		const abort = createAbort()

		let caught: unknown
		try {
			await provider.generate([createUserMessage('hi')], abort.signal)
		} catch (error) {
			caught = error
		}

		expect(isOllamaHTTPError(caught)).toBe(true)
		if (!isOllamaHTTPError(caught)) throw new Error('expected OllamaHTTPError')
		expect(caught.status).toBe(400)
		expect(caught.message).toMatch(/Ollama API error: 400/)
	})

	// Recipe: model 'does-not-exist:zzz' — streaming path, a genuine 404 before any
	// delta. Assertion: structural — a typed OllamaHTTPError with status 404.
	it('surfaces a non-OK status on the streaming path too (live 404 bad model, before any delta)', async () => {
		const provider = new OllamaProvider({ model: 'does-not-exist:zzz', url: OLLAMA_CONFIG.host })
		const abort = createAbort()

		const generator = provider.stream([createUserMessage('hi')], abort.signal)
		let caught: unknown
		try {
			await generator.next()
		} catch (error) {
			caught = error
		}

		expect(isOllamaHTTPError(caught)).toBe(true)
		if (!isOllamaHTTPError(caught)) throw new Error('expected OllamaHTTPError')
		expect(caught.status).toBe(404)
		expect(caught.message).toMatch(/Ollama API error: 404/)
	})

	// Recipe: 'Count slowly from 1 to 40, one number per line.' / num_predict:64
	// (ABORT_OPTIONS) / think:false. Breaks the for-await loop right after the first
	// content delta arrives (an early consumer break, not an abort). Assertion:
	// structural — the break completes promptly (no hang from an uncancelled reader),
	// then a fresh FAST_OPTIONS generate() on the SAME provider still succeeds —
	// guarding the stream's `finally` reader-cancel so the freed connection is reusable.
	it('an early consumer break completes promptly and leaves the provider reusable', async () => {
		const provider = createLiveOllama({ predict: ABORT_OPTIONS.num_predict })
		const abort = createAbort()

		const generator = provider.stream(
			[createUserMessage('Count slowly from 1 to 40, one number per line.')],
			abort.signal,
		)
		const first = await generator.next()
		expect(first.done).toBe(false)

		for await (const _ of generator) break

		const result = await provider.generate(
			[createUserMessage('Say hi.')],
			createAbort().signal,
			undefined,
			{
				think: false,
			},
		)
		expect(result.content.length).toBeGreaterThan(0)
	})
})

// Always runs (no Ollama needed): an unreachable daemon makes generate reject with a
// connection error — the boundary fails loudly rather than hanging.
describe('OllamaProvider (unreachable)', () => {
	it('rejects generate when the daemon is unreachable', async () => {
		const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: 'http://localhost:1' })
		const abort = createAbort()

		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})

	it('rejects stream when the daemon is unreachable, and is NOT a ProviderAbortError', async () => {
		const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: 'http://localhost:1' })
		const abort = createAbort()

		const generator = provider.stream([createUserMessage('Say hello.')], abort.signal)
		let caught: unknown
		try {
			await generator.next()
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(Error)
		expect(isProviderAbortError(caught)).toBe(false)
	})
})

// Always runs (no Ollama needed): a pre-aborted signal makes `fetch` reject before any
// network, and the armed deadline timer must NOT outlive the failed call — a regression
// guard for a leak where `#fetch` cleared the deadline only on the success / non-OK path.
describe('OllamaProvider (deadline cleanup)', () => {
	it('clears the deadline timer when the call rejects, leaking no timer', async () => {
		vi.useFakeTimers()
		try {
			const provider = new OllamaProvider({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host })
			const abort = createAbort()
			abort.abort()

			await expect(
				provider.generate([createUserMessage('Say hello.')], abort.signal),
			).rejects.toThrow(Error)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('clears the deadline timer when an UNREACHABLE call rejects (no leak)', async () => {
		vi.useFakeTimers()
		try {
			const provider = new OllamaProvider({
				model: 'm',
				url: 'http://localhost:1',
				timeout: 90_000,
			})
			const abort = createAbort()
			await expect(provider.generate([createUserMessage('hi')], abort.signal)).rejects.toThrow(
				Error,
			)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})
