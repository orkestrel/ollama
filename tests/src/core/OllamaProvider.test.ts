import type { Message } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { AgentProvider, isProviderAbortError, isProviderError } from '@orkestrel/agent'
import { createRecorder, waitForDelay } from '@orkestrel/test'
import { OllamaProvider } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	createUserMessage,
	DEADLINE_MS,
	DONE_RECORD,
	OLLAMA_CONTEXT_PREFIX,
	OLLAMA_CONTEXT_CASES,
	SETTLE_MS,
	SHORT_OPTIONS,
} from '../../setup.js'
import {
	captureAbortedRequest,
	createRecordingProxy,
	createRefusingTransport,
	createStreamingTransport,
	drive,
	WEATHER_TOOL,
} from '../../setupServer.js'

describe('OllamaProvider (pre-aborted)', () => {
	it('rejects generate when the signal is already aborted', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			options: SHORT_OPTIONS,
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
			options: SHORT_OPTIONS,
		})
		const abort = createAbort()
		abort.abort()

		const generator = provider.stream([createUserMessage('Say hello.')], abort.signal)
		await expect(generator.next()).rejects.toThrow(Error)
	})
})

describe('OllamaProvider (wire seams)', () => {
	it('forwards configured replay and defaults to none', () => {
		expect(new OllamaProvider({ model: 'test-model', replay: 'all' }).replay).toBe('all')
		expect(new OllamaProvider({ model: 'test-model' }).replay).toBe('none')
	})

	it('inherits the shared engine and creates independent framing state', () => {
		const provider = new OllamaProvider({ model: 'test-model' })
		const first = provider.frame()
		const second = provider.frame()

		expect(provider).toBeInstanceOf(AgentProvider)
		expect(first.parse('{"message":{"content":"first"}}')).toEqual([])
		expect(provider.finish(second)).toEqual([])
		expect(provider.finish(first)).toEqual([{ message: { content: 'first' } }])
		expect(provider.finish(first)).toEqual([])
	})

	it('omits the usage key unless done is true and the counts are present', () => {
		const provider = new OllamaProvider({ model: 'test-model' })

		expect(provider.read({ done: false, prompt_eval_count: 99, eval_count: 99 })).toEqual({
			content: '',
			thinking: '',
			tools: [],
		})
		expect(provider.read({ prompt_eval_count: 99, eval_count: 99 })).not.toHaveProperty('usage')
		expect(provider.read({ done: true, prompt_eval_count: 3 })).not.toHaveProperty('usage')
		expect(provider.read({ done: true, prompt_eval_count: 3, eval_count: 4 }).usage).toEqual({
			prompt: 3,
			completion: 4,
			total: 7,
		})
	})

	it('sets truncated only on a done record whose reason is length', () => {
		const provider = new OllamaProvider({ model: 'test-model' })

		expect(provider.read({ done: true, done_reason: 'length' }).truncated).toBe(true)
		expect(provider.read({ done: true, done_reason: 'stop' })).not.toHaveProperty('truncated')
		expect(provider.read({ done: true })).not.toHaveProperty('truncated')
		expect(provider.read({ done: false, done_reason: 'length' })).not.toHaveProperty('truncated')
		expect(provider.read({ done_reason: 'length' })).not.toHaveProperty('truncated')
	})

	it('projects a schema and minimal tool without adding absent tool fields', () => {
		const provider = new OllamaProvider({ model: 'test-model' })
		const schema = { type: 'object', properties: { answer: { type: 'string' } } }
		const body = provider.encode({
			messages: [],
			tools: [{ name: 'weather' }],
			options: { schema },
		})

		expect(body.format).toBe(schema)
		expect(body.tools).toEqual([{ type: 'function', function: { name: 'weather' } }])
	})

	it('never sends a tool title or annotations on the wire', () => {
		const provider = new OllamaProvider({ model: 'test-model' })
		const body = provider.encode({
			messages: [],
			tools: [
				{
					name: 'weather',
					title: 'Weather lookup',
					description: 'Get the current weather for a city.',
					parameters: { type: 'object', properties: { city: { type: 'string' } } },
					annotations: { pure: true },
				},
			],
		})

		const [tool] = body.tools ?? []
		expect(Object.keys(tool?.function ?? {}).sort()).toEqual(['description', 'name', 'parameters'])
	})
})

describe('OllamaProvider (HTTP errors)', () => {
	it('reports a non-OK response through the shared HTTP error taxonomy', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: () => Promise.resolve(new Response('model missing', { status: 404 })),
		})
		const caught: unknown = await provider.generate([], createAbort().signal).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(isProviderError(caught) && caught.code === 'HTTP' && caught.status === 404).toBe(true)
	})
})

// ── Hermetic recording-proxy request-shape tests ─────────────────────────────────
//
// Standard pattern: `captureAbortedRequest` points a provider at a recording proxy,
// generates or streams through it while swallowing the unreachable-upstream outcome, and
// returns the request captured before forwarding, which the test asserts on. These are
// provider-behavior assertions, and the suite passes with the daemon down.

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
			expect(body.stream).toBe(true)
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
			expect(request.text).toBe(
				'{"model":"test-model","messages":[{"role":"user","content":"hello"}],"stream":true,"keep_alive":"9m","think":false,"options":{"num_predict":7,"temperature":0.5},"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the current weather for a city.","parameters":{"type":"object","properties":{"city":{"type":"string","description":"The city name"}},"required":["city"]}}}]}',
			)
		} finally {
			await proxy.stop()
		}
	})

	// Recipe: 'hi' / no options set / think:false (default). Assertion: provider-
	// behavior — keep_alive defaults to '5m', neither options nor tools key present.
	// bounded by abort-once-recorded, no generation awaited.
	it('defaults keep_alive to 5m and omits options/tools when unset', async () => {
		const { body } = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal),
		)

		expect(body.keep_alive).toBe('5m')
		expect('options' in body).toBe(false)
		expect('tools' in body).toBe(false)
	})

	// Recipe: 'hi' / no options / think:true (constructor). Assertion: provider-
	// behavior — think:true rides the wire verbatim.
	// bounded by abort-once-recorded, no generation awaited.
	it('carries think:true on the wire when the option is set', async () => {
		const request = await captureAbortedRequest(
			{ model: 'test-model', think: true },
			(provider, signal) => provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.body.think).toBe(true)
	})

	// Recipe: 'hi' / no options / think omitted. Assertion: provider-behavior —
	// think:false rides the wire by default.
	// bounded by abort-once-recorded, no generation awaited.
	it('carries the default think:false on the wire when the option is omitted', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.body.think).toBe(false)
	})

	// Recipe: 'hi' / constructor think:true, per-call think:false. Assertion:
	// provider-behavior — per-call think overrides the constructor default.
	// bounded by abort-once-recorded, no generation awaited.
	it('per-call think overrides the constructor default', async () => {
		const request = await captureAbortedRequest(
			{ model: 'test-model', think: true },
			(provider, signal) =>
				provider.generate([createUserMessage('hi')], signal, undefined, { think: false }),
		)

		expect(request.body.think).toBe(false)
	})

	// Recipe: 'hi' / constructor think omitted (false), per-call think:true.
	// Assertion: provider-behavior — per-call think can enable over a false default.
	// bounded by abort-once-recorded, no generation awaited.
	it('per-call think can enable reasoning over a constructor default of false', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal, undefined, { think: true }),
		)

		expect(request.body.think).toBe(true)
	})

	// Recipe: 'hi' / an EMPTY tools array passed. Assertion: provider-behavior —
	// no `tools` key rides the wire for an empty array.
	// bounded by abort-once-recorded, no generation awaited.
	it('omits the tools key when an EMPTY tools array is passed', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal, []),
		)

		expect('tools' in request.body).toBe(false)
	})

	// Recipe: 'hi' / streaming path. Assertion: provider-behavior — stream:true rides
	// the wire on the streaming path.
	// bounded by abort-once-recorded, no generation awaited.
	it('sets stream:true on the streaming path', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			drive(provider.stream([createUserMessage('hi')], signal)),
		)

		expect(request.body.stream).toBe(true)
	})

	// Recipe: a 4-turn system/user/assistant(with tool_calls)/tool conversation.
	// Assertion: provider-behavior — every role maps to the wire shape and the
	// assistant's tool_calls replay verbatim.
	// bounded by abort-once-recorded, no generation awaited.
	it('maps every role (system/user/assistant/tool) and replays assistant tool_calls', async () => {
		const messages: readonly Message[] = [
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
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate(messages, signal),
		)

		expect(request.body.messages).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'u' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
			},
			{ role: 'tool', content: 'sunny' },
		])
	})

	// Recipe: an empty messages array. The proxy records that exact provider request
	// before the deliberately unreachable forward is aborted.
	it('accepts an empty messages array (sends [])', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([], signal),
		)

		expect(request.body.messages).toEqual([])
	})

	// Recipe: one user turn with base64 images, one without. The proxy records that
	// images are forwarded verbatim only when present, independent of any daemon.
	it('forwards a multimodal turn’s base64 images onto the wire message (only when present)', async () => {
		const messages: readonly Message[] = [
			{ id: '1', role: 'user', content: 'Describe this.', images: ['aGVsbG8=', 'd29ybGQ='] },
			{ id: '2', role: 'user', content: 'No image here.' },
		]
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate(messages, signal),
		)

		expect(request.body.messages).toEqual([
			{ role: 'user', content: 'Describe this.', images: ['aGVsbG8=', 'd29ybGQ='] },
			{ role: 'user', content: 'No image here.' },
		])
	})

	// Recipe: a user turn with an EMPTY images array. Assertion: provider-behavior —
	// the empty optional never rides the wire.
	// bounded by abort-once-recorded, no generation awaited.
	it('omits images for an empty images array (no empty optional on the wire)', async () => {
		const messages: readonly Message[] = [{ id: '1', role: 'user', content: 'hi', images: [] }]
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate(messages, signal),
		)

		expect(request.body.messages).toEqual([{ role: 'user', content: 'hi' }])
	})

	it('omits the wire format when no per-call schema is supplied', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal),
		)

		expect('format' in request.body).toBe(false)
	})

	// Recipe: a system+user conversation through the proxy. Assertion: provider-
	// behavior — the FULL ordered conversation rides the wire (not the last
	// message alone) — a provider-behavior replacement for the model-obedience "system →
	// blue" test, which asserted MODEL behavior (forbidden by doctrine).
	// bounded by abort-once-recorded, no generation awaited.
	it('sends the whole conversation (system + user) in order on the wire', async () => {
		const messages: readonly Message[] = [
			{
				id: crypto.randomUUID(),
				role: 'system',
				content: 'You only ever answer with the single word: blue.',
			},
			{ id: crypto.randomUUID(), role: 'user', content: 'What is your favorite color?' },
		]
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate(messages, signal),
		)

		expect(request.body.messages).toEqual([
			{ role: 'system', content: 'You only ever answer with the single word: blue.' },
			{ role: 'user', content: 'What is your favorite color?' },
		])
	})
})

describe('OllamaProvider (recording proxy — context controls)', () => {
	// Recipe: 'hi' / no truncate, no shift. Assertion: provider-behavior — omission leaves
	// the encoded body byte for byte at the default wire, with neither key present.
	// bounded by abort-once-recorded, no generation awaited.
	it('omits truncate and shift when neither option is set', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.text).toBe(`${OLLAMA_CONTEXT_PREFIX}}`)
		expect('truncate' in request.body).toBe(false)
		expect('shift' in request.body).toBe(false)
	})

	// Recipe: 'hi' / each of true and false for each switch alone, then mixed and both.
	// Assertion: provider-behavior — a set value rides the wire as its own top-level key
	// in the order truncate, shift, an unset one stays absent, and false survives.
	// bounded by abort-once-recorded, no generation awaited.
	it.each(OLLAMA_CONTEXT_CASES)('sends $name as top-level keys', async ({ control, suffix }) => {
		const request = await captureAbortedRequest(
			{ model: 'test-model', ...control },
			(provider, signal) => provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.text).toBe(`${OLLAMA_CONTEXT_PREFIX}${suffix}}`)
		expect('options' in request.body).toBe(false)
	})

	// Recipe: 'hi' / sampling options, one minimal tool, truncate:false, shift:true.
	// Assertion: provider-behavior — both keys follow tools at the top level, the options
	// bag stays exactly as configured, and the fields before them keep their order.
	// bounded by abort-once-recorded, no generation awaited.
	it('places truncate and shift after tools and never inside options', async () => {
		const request = await captureAbortedRequest(
			{
				model: 'test-model',
				options: { num_predict: 7 },
				truncate: false,
				shift: true,
			},
			(provider, signal) =>
				provider.generate([createUserMessage('hi')], signal, [{ name: 'weather' }]),
		)

		expect(request.text).toBe(
			`${OLLAMA_CONTEXT_PREFIX},"options":{"num_predict":7},"tools":[{"type":"function","function":{"name":"weather"}}],"truncate":false,"shift":true}`,
		)
		expect(request.body.options).toEqual({ num_predict: 7 })
	})

	// Recipe: 'hi' / truncate:false, shift:false on the streaming path. Assertion: provider-
	// behavior — stream shares the encoder with generate, so it sends the same body.
	// bounded by abort-once-recorded, no generation awaited.
	it('sends the same truncate and shift on the streaming path', async () => {
		const request = await captureAbortedRequest(
			{ model: 'test-model', truncate: false, shift: false },
			(provider, signal) => drive(provider.stream([createUserMessage('hi')], signal)),
		)

		expect(request.text).toBe(`${OLLAMA_CONTEXT_PREFIX},"truncate":false,"shift":false}`)
	})
})

describe('OllamaProvider (recording proxy — transport seam headers)', () => {
	// bounded by abort-once-recorded, no generation awaited.
	it('merges a dynamically-injected header onto the request (the obfuscated token reaches the server)', async () => {
		const request = await captureAbortedRequest(
			{ model: 'test-model', headers: () => ({ authorization: 'Bearer obfuscated-xyz' }) },
			(provider, signal) => provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.headers.authorization).toBe('Bearer obfuscated-xyz')
		expect(request.headers['content-type']).toBe('application/json')
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('applies an ASYNC headers hook (a Promise-returning injector resolves and is merged)', async () => {
		const request = await captureAbortedRequest(
			{
				model: 'test-model',
				headers: async () => {
					await Promise.resolve()
					return { authorization: 'Bearer async-token', 'x-extra': '1' }
				},
			},
			(provider, signal) => provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.headers.authorization).toBe('Bearer async-token')
		expect(request.headers['x-extra']).toBe('1')
		expect(request.headers['content-type']).toBe('application/json')
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('lets the hook override Content-Type when it explicitly returns one', async () => {
		const request = await captureAbortedRequest(
			{
				model: 'test-model',
				headers: () => ({ 'Content-Type': 'application/json; charset=utf-8' }),
			},
			(provider, signal) => provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.headers['content-type']).toBe('application/json; charset=utf-8')
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('the headers hook applies on the STREAMING path too', async () => {
		const request = await captureAbortedRequest(
			{ model: 'test-model', headers: () => ({ authorization: 'Bearer stream-token' }) },
			(provider, signal) => drive(provider.stream([createUserMessage('hi')], signal)),
		)

		expect(request.headers.authorization).toBe('Bearer stream-token')
		expect(request.headers['content-type']).toBe('application/json')
	})

	// bounded by abort-once-recorded, no generation awaited.
	it('sends ONLY the base Content-Type when headers is omitted (default unchanged)', async () => {
		const request = await captureAbortedRequest({ model: 'test-model' }, (provider, signal) =>
			provider.generate([createUserMessage('hi')], signal),
		)

		expect(request.headers['content-type']).toBe('application/json')
		expect(request.headers.authorization).toBeUndefined()
	})
})

describe('OllamaProvider (transport seam — orthogonal to the deadline)', () => {
	// Recipe: a headers hook set, one pre-aborted call and one live-signal call, both
	// refused by the transport. Assertion: provider-behavior — a pre-aborted call reaches
	// neither the headers hook nor the transport, and the deadline armed around the
	// refused live call is cleared.
	it('a pre-aborted call reaches neither the headers hook nor the transport, and clears the deadline of a refused one', async () => {
		const transport = createRefusingTransport()
		const signals = createRecorder<readonly [AbortSignal]>()
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			timeout: DEADLINE_MS,
			headers: (signal) => {
				signals.handler(signal)
				return { authorization: 'Bearer x' }
			},
			fetch: transport.fetch,
		})
		const aborted = createAbort()
		aborted.abort()

		await expect(provider.generate([createUserMessage('hi')], aborted.signal)).rejects.toThrow(
			Error,
		)
		expect(signals.calls).toEqual([])

		await expect(
			provider.generate([createUserMessage('hi')], createAbort().signal),
		).rejects.toThrow(Error)
		await waitForDelay(SETTLE_MS)

		expect(transport.signals.length).toBe(1)
		expect(transport.signals[0]?.aborted).toBe(false)
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
		const caught: unknown = await generator.next().then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(caught).toBeInstanceOf(Error)
		expect(isProviderAbortError(caught)).toBe(false)
	})
})

// Always runs (no Ollama needed): the base's deadline must NOT outlive a failed
// call — a regression guard for a leak where the deadline was cleared only on the
// success / non-OK path. The signal each request rode is the deadline's observable
// outlet: an uncleared deadline aborts it on expiry, a cleared one never does. The
// transport refuses in-process, so reading the signal never races a connection attempt.
describe('OllamaProvider (deadline cleanup)', () => {
	// The control for the guard below: a slow headers hook holds the call past the
	// deadline, so the signal received by the hook aborts. It proves an unaborted signal is
	// a result rather than the only value that assertion can produce. The base passes one
	// combined signal to the header hook and to the transport, which is why the hook's
	// signal stands in for the transport's in this control.
	it('aborts the request the deadline was armed around when that deadline expires', async () => {
		const transport = createRefusingTransport()
		const signals = createRecorder<readonly [AbortSignal]>()
		const provider = new OllamaProvider({
			model: 'test-model',
			url: 'http://127.0.0.1:1',
			timeout: DEADLINE_MS,
			headers: async (signal) => {
				signals.handler(signal)
				await waitForDelay(SETTLE_MS)
				return { authorization: 'Bearer slow' }
			},
			fetch: transport.fetch,
		})

		await expect(
			provider.generate([createUserMessage('hi')], createAbort().signal),
		).rejects.toThrow(Error)

		expect(signals.calls.map(([signal]) => signal.aborted)).toEqual([true])
		expect(transport.signals).toEqual([])
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
	it('omits usage before done and folds the done record usage into generate', async () => {
		const unfinished = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"answer"},"done":false,"prompt_eval_count":99,"eval_count":99}\n',
			]),
		})
		const finished = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"answer"},"done":false,"prompt_eval_count":99,"eval_count":99}\n',
				DONE_RECORD,
			]),
		})

		expect(await unfinished.generate([], createAbort().signal)).toEqual({ content: 'answer' })
		expect(await finished.generate([], createAbort().signal)).toEqual({
			content: 'answer',
			usage: { prompt: 3, completion: 4, total: 7 },
		})
	})

	it('folds a length done reason into a truncated result beside the usage', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"cut"},"done":false}\n',
				'{"done":true,"done_reason":"length","prompt_eval_count":3,"eval_count":8}\n',
			]),
		})

		expect(await provider.generate([], createAbort().signal)).toEqual({
			content: 'cut',
			usage: { prompt: 3, completion: 8, total: 11 },
			truncated: true,
		})
	})

	it('folds a length done reason that carries no counts into a truncated result without usage', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"cut"}}\n',
				'{"done":true,"done_reason":"length"}\n',
			]),
		})

		expect(await provider.generate([], createAbort().signal)).toEqual({
			content: 'cut',
			truncated: true,
		})
	})

	it('leaves the result unchanged for a stop reason and ignores a stray reason on a delta line', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"whole"},"done":false,"done_reason":"length"}\n',
				'{"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":4}\n',
			]),
		})

		const { result } = await drive(
			provider.stream([createUserMessage('Say hello.')], createAbort().signal),
		)

		expect(result).toEqual({
			content: 'whole',
			usage: { prompt: 3, completion: 4, total: 7 },
		})
	})

	it('yields each channel-tagged delta and returns the folded result', async () => {
		const provider = new OllamaProvider({
			model: 'test-model',
			fetch: createStreamingTransport([
				'{"message":{"content":"Hel"}}\n',
				'{"message":{"thinking":"weighing it"}}\n{"message":{"content":"lo"}}\n',
				'{"message":{"tool_calls":[{"id":"call-1","function":{"name":"weather","arguments":{"city":"Oslo"}}}]}}\n',
				DONE_RECORD,
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
