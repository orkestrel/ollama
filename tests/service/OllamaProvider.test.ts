import { createAbort } from '@orkestrel/abort'
import { isProviderAbortError } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { isOllamaHTTPError, OllamaProvider } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../setup.js'
import {
	createRecordingProxy,
	createRecordingTransport,
	drive,
	waitForRequest,
	WEATHER_TOOL,
} from '../setupServer.js'
import {
	ABORT_OPTIONS,
	createLiveOllama,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
	SEED_OPTIONS,
	STREAM_OPTIONS,
	THINK_OPTIONS,
	TOOL_OPTIONS,
} from '../setupService.js'

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
	// (non-empty id, correct name, object arguments). Bounded retry (attempts=3) over
	// the small model's nondeterminism — probe measured 3/3 hit rate,
	// but a small sample, so each attempt reissues the SAME call until one carries at
	// least one tool call; the strict shape assertions then run on that response.
	it('populates result.tools when the model calls a tool (id/name/arguments)', async () => {
		const provider = createLiveOllama({ predict: TOOL_OPTIONS.num_predict })

		const result = await retryUntil(
			'produce a tool_call for get_weather',
			() =>
				provider.generate(
					[createUserMessage('What is the weather in Paris? Use the get_weather tool.')],
					createAbort().signal,
					[WEATHER_TOOL],
				),
			(value) => (value.tools ?? []).length > 0,
			{ attempts: 3, budget: RETRY_BUDGET },
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
		const provider = createLiveOllama({ predict: THINK_OPTIONS.num_predict })
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

	// Recipe: 'What is 2+2? Reply with just the number.' / inline
	// { num_predict: 768, temperature: 0 } / think:true. Calibration note: at
	// temperature:0 a retry replays the SAME trace on a given host, so the prompt —
	// not the budget — must guarantee the trace closes: compliance-style prompts
	// ("say only the word hello") send some hosts into an unbounded second-guessing
	// loop that consumed a 768 budget without landing content, while trivial
	// arithmetic closes in a few dozen thinking tokens on every observed host (do
	// not shrink the budget toward THINK_OPTIONS-scale; it will go vacuous again,
	// per the sibling case above where content "may be empty"). Assertion:
	// structural — thinking non-empty, content non-empty (the think→content
	// transition seam: the model finished reasoning and the answer landed in the
	// CONTENT channel, not lost or misrouted), and content does not contain the
	// thinking text (channel separation).
	it('finishes reasoning and lands the answer in content, not lost or misrouted (think→content seam)', async () => {
		const result = await retryUntil(
			'finish reasoning AND land the answer in content within the calibrated think budget',
			async () => {
				const provider = new OllamaProvider({
					model: OLLAMA_CONFIG.model,
					url: OLLAMA_CONFIG.host,
					think: true,
					options: { num_predict: 768, temperature: 0 },
				})
				return provider.generate(
					[createUserMessage('What is 2+2? Reply with just the number.')],
					createAbort().signal,
					undefined,
					{ think: true },
				)
			},
			(value) => (value.thinking ?? '').length > 0 && value.content.length > 0,
			{ attempts: 3, budget: RETRY_BUDGET },
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
	// stream lines, correct name, non-empty id. Bounded retry (attempts=3) over the
	// small model's nondeterminism — probe measured 3/3 hit rate,
	// but a small sample, so each attempt reissues the SAME call until one carries at
	// least one tool call; the strict shape assertions then run on that response.
	it('assembles tool calls from a streamed turn', async () => {
		const provider = createLiveOllama({ predict: TOOL_OPTIONS.num_predict })

		const result = await retryUntil(
			'produce a tool_call for get_weather',
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
			{ attempts: 3, budget: RETRY_BUDGET },
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

	// Recipe: 'Recite the numbers from 1 to 1000 in order, one number per line.' /
	// inline { num_predict: 4096, temperature: 0 } / think:false, provider deadline
	// SELF-CALIBRATED — the PROVIDER'S OWN timeout (not the caller's signal) trips
	// mid-stream. Calibration note: no static deadline survives every host — a fast
	// machine finished a bounded count inside 2000ms and can EOS an "endless" prompt
	// at will — but temperature:0 REPLAYS the same stream on a given host, so the
	// test first drives the exact stream unbounded (caller-capped at 6s) to measure
	// when content starts and when it ends, then re-runs it with the provider
	// deadline armed at the midpoint of that measured window: provably after the
	// first content delta and before the stream's own end on THIS host. Assertion:
	// structural — ProviderAbortError with non-empty partial content.
	it('its own timeout aborts a slow stream with ProviderAbortError carrying the partial', async () => {
		const prompt = 'Recite the numbers from 1 to 1000 in order, one number per line.'
		const options = { num_predict: 4096, temperature: 0 }

		const probe = new OllamaProvider({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			options,
		})
		const probeAbort = createAbort()
		const started = performance.now()
		let first: number | undefined
		let ended: number | undefined
		const generator = probe.stream([createUserMessage(prompt)], probeAbort.signal)
		try {
			for (;;) {
				const step = await generator.next()
				if (step.done) {
					ended = performance.now()
					break
				}
				if (step.value.channel === 'content' && first === undefined) first = performance.now()
				if (performance.now() - started > 6000) probeAbort.abort()
			}
		} catch (error) {
			// The caller cap tripped while the stream was mid-flight — that end is the window edge.
			if (!isProviderAbortError(error)) throw error
			ended = performance.now()
		}
		if (first === undefined || ended === undefined) throw new Error('probe produced no content')
		const window = ended - first
		// A window this narrow means the model refused the enumeration outright; the
		// deadline claim needs a genuinely streaming run, so fail with the diagnosis.
		expect(window).toBeGreaterThan(250)
		const deadline = Math.round(first - started + window / 2)

		const provider = new OllamaProvider({
			model: OLLAMA_CONFIG.model,
			url: OLLAMA_CONFIG.host,
			timeout: deadline,
			options,
		})
		const abort = createAbort()

		let caught: unknown
		try {
			await drive(provider.stream([createUserMessage(prompt)], abort.signal))
		} catch (error) {
			caught = error
		}

		expect(isProviderAbortError(caught)).toBe(true)
		if (!isProviderAbortError(caught)) throw new Error('expected ProviderAbortError')
		expect(caught.partial.content.length).toBeGreaterThan(0)
	})
})

describe('OllamaProvider (recording proxy — structured-output schema)', () => {
	// Recipe: 'Give me a city and its population.' / num_predict:64, temperature:0 /
	// think:false / options.schema constraining {city:string, population:number}.
	// Assertion: wire-truth — the recorded body carries `format` deep-equal to the
	// schema (deterministic); response-shape — the assembled content JSON.parses to an
	// object with a string `city` and a numeric `population` (bounded retry, attempts=3,
	// over the small model's nondeterminism at this budget). Also
	// proves the negative: a schema-less call on the SAME proxy carries no `format` key.
	const SCHEMA = {
		type: 'object',
		properties: { city: { type: 'string' }, population: { type: 'number' } },
		required: ['city', 'population'],
	} as const

	it('sends the schema as `format` on the wire and returns matching structured JSON; omits format when no schema is given', async () => {
		const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
		try {
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				options: { num_predict: 64, temperature: 0 },
			})

			const result = await retryUntil(
				'return content that JSON.parses to {city: string, population: number}',
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
				{ attempts: 3, budget: RETRY_BUDGET },
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

describe('OllamaProvider (recording proxy — transport seam custom fetch)', () => {
	// Recipe: 'hi' / FAST_OPTIONS-scale (default options) / think:false. Assertion:
	// provider-behavior — the injected fetch is the one used (a real delegating
	// recorder, not a mock), exactly once, and the real content
	// still comes back through it.
	it('uses the injected fetch, not the global (a real delegating recorder)', async () => {
		const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
		try {
			const calls = createRecorder<readonly [string]>()
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				fetch: createRecordingTransport(calls),
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
		const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
		try {
			const calls = createRecorder<readonly [string]>()
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				fetch: createRecordingTransport(calls),
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
