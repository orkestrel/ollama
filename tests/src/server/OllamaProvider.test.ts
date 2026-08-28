import type { ContextFormatInterface, MessageInterface } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { isProviderAbortError } from '@orkestrel/agent'
import { waitForDelay } from '@orkestrel/test'
import { OllamaProvider } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../setup.js'
import {
	createRecordingProxy,
	createRefusingTransport,
	createStreamingTransport,
	drive,
	waitForRequest,
	WEATHER_TOOL,
} from '../../setupServer.js'

const FRAMING: ContextFormatInterface = {
	instructions: {
		open: '<instructions>',
		render: (one) => `<instruction>${one.content}</instruction>`,
		close: '</instructions>',
	},
}

/** The real per-call deadline the deadline tests arm, in milliseconds. */
const DEADLINE_MS = 25

/** How long to wait past that deadline before reading whether it fired. */
const SETTLE_MS = DEADLINE_MS * 4

describe('OllamaProvider (pre-aborted)', () => {
	it('rejects generate when the signal is already aborted', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			options: { num_predict: 8, temperature: 0 },
		})
		const abort = createAbort()
		abort.abort()

		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})

	it('rejects stream when the signal is already aborted (before any content)', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			options: { num_predict: 8, temperature: 0 },
		})
		const abort = createAbort()
		abort.abort()

		const generator = provider.stream([createUserMessage('Say hello.')], abort.signal)
		await expect(generator.next()).rejects.toThrow(Error)
	})
})

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

// ── Hermetic recording-proxy request-shape tests ─────────────────────────────────
//
// Standard pattern: create a proxy, point a provider at it, generate or stream through
// it while swallowing the unreachable-upstream outcome, then assert on the request body
// and headers captured before forwarding. These are provider-behavior assertions, and
// the suite passes with the daemon down.

describe('OllamaProvider (recording proxy — request body)', () => {
	// Recipe: 'hello' / num_predict:7, temperature:0.5 / think:false (constructor default).
	// Assertion: provider-behavior — exact wire body shape (model/stream/keep_alive/
	// think/options/messages/tools).
	it('posts model/messages/stream/keep_alive and the default think:false; options + tools when set', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: 'test-model',
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
			expect(body.model).toBe('test-model')
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
				model: 'test-model',
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
				model: 'test-model',
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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

	// Recipe: an empty messages array. The proxy records that exact provider request
	// before the deliberately unreachable forward is aborted.
	it('accepts an empty messages array (sends [])', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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

	// Recipe: one user turn with base64 images, one without. The proxy records that
	// images are forwarded verbatim only when present, independent of any daemon.
	it('forwards a multimodal turn’s base64 images onto the wire message (only when present)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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
				model: 'test-model',
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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

describe('OllamaProvider (recording proxy — transport seam headers)', () => {
	// bounded by abort-once-recorded, no generation awaited.
	it('merges a dynamically-injected header onto the request (the obfuscated token reaches the server)', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: 'test-model',
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
				model: 'test-model',
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
				model: 'test-model',
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
				model: 'test-model',
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
			const provider = new OllamaProvider({ model: 'test-model', url: proxy.url })
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

describe('OllamaProvider (transport seam — orthogonal to the deadline)', () => {
	// Recipe: a headers hook set, one pre-aborted call and one live-signal call, both
	// refused by the transport. Assertion: provider-behavior — the hook changes neither
	// outcome, and the deadline armed around the refused call is cleared. A pre-aborted
	// call rides an already-aborted signal, so the live-signal call is what reads the
	// deadline; the pre-aborted call proves the rejection stays clean with a hook set.
	it('rejects a pre-aborted call carrying a headers hook, and clears the deadline of a refused one', async () => {
		const transport = createRefusingTransport()
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			timeout: DEADLINE_MS,
			headers: () => ({ authorization: 'Bearer x' }),
			fetch: transport.fetch,
		})
		const aborted = createAbort()
		aborted.abort()

		await expect(provider.generate([createUserMessage('hi')], aborted.signal)).rejects.toThrow(
			Error,
		)
		await expect(
			provider.generate([createUserMessage('hi')], createAbort().signal),
		).rejects.toThrow(Error)
		await waitForDelay(SETTLE_MS)

		expect(transport.signals.length).toBe(2)
		expect(transport.signals[1]?.aborted).toBe(false)
	})

	// Recipe: the hook rejects before the request is built, so no network is reached.
	// Assertion: provider-behavior — the hook's error surfaces verbatim and NOTHING
	// reaches the daemon. The provider addresses the proxy here, so a request that
	// escaped the rejected hook would be recorded.
	it('an async-headers hook that REJECTS surfaces its error and reaches no daemon', async () => {
		const proxy = await createRecordingProxy()
		try {
			const provider = new OllamaProvider({
				model: 'test-model',
				url: proxy.url,
				timeout: DEADLINE_MS,
				headers: () => Promise.reject(new Error('token fetch failed')),
			})
			await expect(
				provider.generate([createUserMessage('hi')], createAbort().signal),
			).rejects.toThrow('token fetch failed')
			await waitForDelay(SETTLE_MS)

			expect(proxy.requests.length).toBe(0)
		} finally {
			await proxy.stop()
		}
	})
})

// Always runs (no Ollama needed): an unreachable daemon makes generate reject with a
// connection error — the boundary fails loudly rather than hanging.
describe('OllamaProvider (unreachable)', () => {
	it('rejects generate when the daemon is unreachable', async () => {
		const provider = new OllamaProvider({ model: 'test-model', url: 'http://localhost:1' })
		const abort = createAbort()

		await expect(
			provider.generate([createUserMessage('Say hello.')], abort.signal),
		).rejects.toThrow(Error)
	})

	it('rejects stream when the daemon is unreachable, and is NOT a ProviderAbortError', async () => {
		const provider = new OllamaProvider({ model: 'test-model', url: 'http://localhost:1' })
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

// Always runs (no Ollama needed): the deadline `#fetch` arms must NOT outlive a failed
// call — a regression guard for a leak where `#fetch` cleared the deadline only on the
// success / non-OK path. The signal each request rode is the deadline's observable
// outlet: an uncleared deadline aborts it on expiry, a cleared one never does. The
// transport refuses in-process, so reading the signal never races a connection attempt.
describe('OllamaProvider (deadline cleanup)', () => {
	// The control for the two guards below: a slow headers hook holds the call past the
	// deadline, so the recorded signal aborts. It proves an unaborted recorded signal is
	// a result rather than the only value those assertions can produce.
	it('aborts the request the deadline was armed around when that deadline expires', async () => {
		const transport = createRefusingTransport()
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			timeout: DEADLINE_MS,
			headers: async () => {
				await waitForDelay(SETTLE_MS)
				return { authorization: 'Bearer slow' }
			},
			fetch: transport.fetch,
		})

		await expect(
			provider.generate([createUserMessage('hi')], createAbort().signal),
		).rejects.toThrow(Error)

		expect(transport.signals.length).toBe(1)
		expect(transport.signals[0]?.aborted).toBe(true)
	})

	it('clears the deadline when a pre-aborted call rejects', async () => {
		const transport = createRefusingTransport()
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			timeout: DEADLINE_MS,
			fetch: transport.fetch,
		})
		const aborted = createAbort()
		aborted.abort()

		await expect(
			provider.generate([createUserMessage('Say hello.')], aborted.signal),
		).rejects.toThrow(Error)
		// The pre-aborted call's own signal is aborted before the deadline can touch it,
		// so a live-signal call through the same provider carries the readable deadline.
		await expect(
			provider.generate([createUserMessage('Say hello.')], createAbort().signal),
		).rejects.toThrow(Error)
		await waitForDelay(SETTLE_MS)

		expect(transport.signals.length).toBe(2)
		expect(transport.signals[1]?.aborted).toBe(false)
	})

	it('clears the deadline when the transport refuses the connection', async () => {
		const transport = createRefusingTransport()
		const provider = new OllamaProvider({
			model: 'm',
			url: 'http://localhost:1',
			timeout: DEADLINE_MS,
			fetch: transport.fetch,
		})

		await expect(
			provider.generate([createUserMessage('hi')], createAbort().signal),
		).rejects.toThrow(Error)
		await waitForDelay(SETTLE_MS)

		expect(transport.signals.length).toBe(1)
		expect(transport.signals[0]?.aborted).toBe(false)
	})
})

describe('OllamaProvider (streaming fold over a canned NDJSON daemon)', () => {
	it('yields each channel-tagged delta and returns the folded result', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"Hel"}}\n',
				'{"message":{"thinking":"weighing it"}}\n{"message":{"content":"lo"}}\n',
				'{"message":{"tool_calls":[{"id":"call-1","function":{"name":"weather","arguments":{"city":"Oslo"}}}]}}\n',
				'{"done":true,"prompt_eval_count":3,"eval_count":4}\n',
			]),
		})

		const { deltas, thoughts, result } = await drive(
			provider.stream([createUserMessage('Say hello.')], createAbort().signal),
		)

		expect(deltas.join('')).toBe('Hello')
		expect(thoughts).toEqual(['weighing it'])
		expect(result.content).toBe('Hello')
		expect(result.thinking).toBe('weighing it')
		expect(result.tools).toEqual([{ id: 'call-1', name: 'weather', arguments: { city: 'Oslo' } }])
		expect(result.usage).toEqual({ prompt: 3, completion: 4, total: 7 })
	})

	it('accumulates tool calls across records and keeps the usage of the done line', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"tool_calls":[{"id":"call-1","function":{"name":"weather"}}]}}\n',
				'{"message":{"tool_calls":[{"id":"call-2","function":{"name":"clock"}}]}}\n',
				'{"done":true,"prompt_eval_count":1,"eval_count":2}\n',
				'{"message":{"content":"trailing"}}\n',
			]),
		})

		const { result } = await drive(
			provider.stream([createUserMessage('Say hello.')], createAbort().signal),
		)

		expect(result.tools?.map((call) => call.name)).toEqual(['weather', 'clock'])
		expect(result.usage).toEqual({ prompt: 1, completion: 2, total: 3 })
	})

	it('recovers an unterminated final done line through the tail flush', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"ok"}}\n',
				'{"done":true,"prompt_eval_count":5,"eval_count":6}',
			]),
		})

		const { deltas, result } = await drive(
			provider.stream([createUserMessage('Say hello.')], createAbort().signal),
		)

		expect(deltas.join('')).toBe('ok')
		expect(result.usage).toEqual({ prompt: 5, completion: 6, total: 11 })
	})

	it('separates inline think tags out of the yielded content and onto thinking', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"<think>reasoning</think>answer"}}\n',
				'{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
			]),
		})

		const { deltas, result } = await drive(
			provider.stream([createUserMessage('Say hello.')], createAbort().signal),
		)

		expect(deltas.join('')).toBe('answer')
		expect(result.content).toBe('answer')
		expect(result.thinking).toBe('reasoning')
	})

	it('joins the separated in-content span with the wire-side thinking', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"<think>from content</think>answer","thinking":"from the wire"}}\n',
				'{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
			]),
		})

		const { result } = await drive(
			provider.stream([createUserMessage('Say hello.')], createAbort().signal),
		)

		expect(result.thinking).toBe('from content\n\nfrom the wire')
	})
})
